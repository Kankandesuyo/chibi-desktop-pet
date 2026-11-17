import type { BrowserWindow } from 'electron';
import { defineTool } from '../types';

let window: BrowserWindow | undefined;
let sources: string[] = [];
const engines = {
  bing: ['https://www.bing.com/search?q=', '#b_results .b_algo h2 a'],
  baidu: ['https://www.baidu.com/s?wd=', '#content_left h3 a'],
  google: ['https://www.google.com/search?q=', '#search a:has(h3)'],
} as const;

function getWindow() {
  if (window && !window.isDestroyed()) return window;
  const { BrowserWindow, session } = require('electron') as typeof import('electron');
  const isolated = session.fromPartition('pet-web-research');
  isolated.setPermissionRequestHandler((_wc, _permission, respond) => respond(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.setDevicePermissionHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, respond) => {
    respond({ cancel: !/^https?:\/\//i.test(details.url) });
  });
  if (!isolated.listenerCount('will-download')) isolated.on('will-download', event => event.preventDefault());
  const win = new BrowserWindow({
    title: '桌宠浏览器', width: 1000, height: 720, autoHideMenuBar: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault(); });
  win.on('page-title-updated', (event, title) => { event.preventDefault(); win.setTitle('桌宠浏览器 · ' + title.slice(0, 100)); });
  win.on('closed', () => { window = undefined; sources = []; });
  window = win;
  return win;
}

async function visit(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const win = getWindow();
  const contents = win.webContents;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => { reject(new Error(signal.aborted ? '已取消浏览' : '网页加载超时')); if (!contents.isDestroyed()) contents.stop(); };
    deadline.addEventListener('abort', cancel, { once: true });
  });
  try {
    await Promise.race([contents.loadURL(url), stopped]);
    return contents;
  } finally { deadline.removeEventListener('abort', cancel); }
}

export const petWebSearch = defineTool<{query: string; engine?: keyof typeof engines}>({
  name: 'pet_web_search', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '在桌宠内置浏览器搜索公开资料。返回编号、标题和链接，供 pet_web_read 继续阅读。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, engine: { type: 'string', enum: ['bing', 'baidu', 'google'] } }, required: ['query'] },
  title: a => '联网搜索：' + a.query,
  execute: async (a, ctx) => {
    sources = [];
    const [base, selector] = engines[a.engine ?? 'bing'];
    const page = await visit(base + encodeURIComponent(a.query), ctx.signal);
    const results: {title: string; url: string}[] = await page.executeJavaScriptInIsolatedWorld(999, [{code:
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(a => ({title: a.innerText.trim().slice(0,200), url: a.href})).filter(r => r.title && /^https?:/.test(r.url)).slice(0,10)`
    }]);
    sources = results.map(item => item.url);
    if (!results.length) return { ok: false, summary: '未读到搜索结果', error: '搜索页可能要求验证或暂时不可用，可换搜索引擎再试。', external: true };
    return { ok: true, summary: '找到 ' + results.length + ' 条搜索结果', data: results.map((r,i) => ({ index: i + 1, ...r })), external: true };
  },
});

export const petWebRead = defineTool<{index: number}>({
  name: 'pet_web_read', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '在桌宠内置浏览器阅读上一次搜索结果中的指定条目，返回正文和实际来源网址。',
  inputSchema: { type: 'object', properties: { index: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['index'] },
  title: a => '阅读搜索结果 ' + a.index,
  execute: async (a, ctx) => {
    const url = sources[a.index - 1];
    if (!url) return { ok: false, summary: '找不到这条结果', error: '请重新搜索并选择有效编号。' };
    const page = await visit(url, ctx.signal);
    const text: string = await page.executeJavaScriptInIsolatedWorld(999, [{code: "(document.querySelector('main,article') || document.body)?.innerText.trim().slice(0,10000) || ''"}]);
    if (!text) return { ok: false, summary: '网页没有可读正文', error: '可尝试其他来源。' };
    return { ok: true, summary: '已读取 ' + page.getTitle(), data: { url: page.getURL(), title: page.getTitle(), text }, external: true };
  },
});

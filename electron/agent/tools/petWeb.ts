import type { BrowserWindow, Session, WebContents } from 'electron';
import { defineTool } from '../types';

let window: BrowserWindow | undefined;
/** The pane inside the main window (set by the main process); without it a separate window is used. */
let host: { contents(): Promise<WebContents>; close(): void } | null = null;
/** The page searches and reads happen in (the pane's, or the separate window's). */
let current: WebContents | undefined;
export function setPetBrowserHost(h: typeof host): void { host = h; }
/** Results of the last search, per task (helpers searching side by side must not swap results). */
const sources = new Map<string, string[]>();
/** There is one browser window: searches and reads take turns. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}
const engines = {
  bing: ['https://www.bing.com/search?q=', '#b_results .b_algo h2 a'],
  baidu: ['https://www.baidu.com/s?wd=', '#content_left h3 a'],
  google: ['https://www.google.com/search?q=', '#search a:has(h3)'],
} as const;

const windows = new Set<BrowserWindow>();

/** Separate, locked-down session for the pet's browsing: no permissions, no downloads, only http(s). */
let research: Session | undefined;
export function researchSession(): Session {
  if (research) return research;
  const { session } = require('electron') as typeof import('electron');
  const isolated = session.fromPartition('pet-web-research');
  isolated.setPermissionRequestHandler((_wc, _permission, respond) => respond(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.setDevicePermissionHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, respond) => {
    respond({ cancel: !/^(https?|data|blob):/i.test(details.url) });
  });
  if (!isolated.listenerCount('will-download')) isolated.on('will-download', event => event.preventDefault());
  research = isolated;
  return isolated;
}

function getWindow(newWindow = false) {
  if (!newWindow && window && !window.isDestroyed()) return window;
  const { BrowserWindow } = require('electron') as typeof import('electron');
  const isolated = researchSession();
  const win = new BrowserWindow({
    title: '桌宠浏览器', width: 1000, height: 720, autoHideMenuBar: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault(); });
  win.on('page-title-updated', (event, title) => { event.preventDefault(); win.setTitle('桌宠浏览器 · ' + title.slice(0, 100)); });
  windows.add(win);
  win.on('focus', () => { window = win; });
  win.on('closed', () => {
    windows.delete(win);
    if (window === win) window = [...windows].at(-1);
    if (!windows.size) sources.clear();
  });
  window = win;
  return win;
}

async function visit(url: string, signal: AbortSignal, newWindow = false) {
  signal.throwIfAborted();
  let contents: WebContents;
  if (host) contents = await host.contents();
  else {
    const win = getWindow(newWindow);
    if (win.isMinimized()) win.restore();
    win.show();
    contents = win.webContents;
  }
  current = contents;
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

export function openPetPage(url: string, signal: AbortSignal, newWindow = false) {
  return exclusive(async () => {
    const page = await visit(url, signal, newWindow);
    return { title: page.getTitle(), url: page.getURL() };
  });
}

export function extractPetPage(args: { selector?: string; maxChars?: number; includeLinks?: boolean }) {
  return exclusive(async () => {
    const page = current && !current.isDestroyed() ? current : window && !window.isDestroyed() ? window.webContents : undefined;
    if (!page) throw new Error('请先在桌宠浏览器中打开网页');
    const selector = JSON.stringify(args.selector ?? 'body');
    const max = Math.min(30000, Math.max(200, args.maxChars ?? 8000));
    const content = await page.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const node = document.querySelector(${selector});
      if (!node) throw new Error('找不到指定的页面元素');
      const text = node.innerText ?? node.textContent ?? '';
      const links = ${!!args.includeLinks} ? Array.from(document.querySelectorAll('a[href]')).slice(0,40)
        .map(a => ({ text: a.textContent.trim().slice(0,80), url: a.href })) : undefined;
      return { text: text.slice(0,${max}), truncated: text.length > ${max}, links };
    })()` }]) as { text: string; truncated: boolean; links?: { text: string; url: string }[] };
    return { ...content, title: page.getTitle(), url: page.getURL() };
  });
}

export function closePetBrowser() {
  host?.close();
  current = undefined;
  for (const win of windows) if (!win.isDestroyed()) win.close();
}

export const petWebSearch = defineTool<{query: string; engine?: keyof typeof engines}>({
  name: 'pet_web_search', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '在桌宠内置浏览器搜索公开资料。返回编号、标题和链接，供 pet_web_read 继续阅读。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, engine: { type: 'string', enum: ['bing', 'baidu', 'google'] } }, required: ['query'] },
  title: a => '联网搜索：' + a.query,
  execute: async (a, ctx) => exclusive(async () => {
    sources.delete(ctx.taskId);
    const [base, selector] = engines[a.engine ?? 'bing'];
    const page = await visit(base + encodeURIComponent(a.query), ctx.signal);
    const results: {title: string; url: string}[] = await page.executeJavaScriptInIsolatedWorld(999, [{code:
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(a => ({title: a.innerText.trim().slice(0,200), url: a.href})).filter(r => r.title && /^https?:/.test(r.url)).slice(0,10)`
    }]);
    sources.set(ctx.taskId, results.map(item => item.url));
    if (!results.length) return { ok: false, summary: '未读到搜索结果', error: '搜索页可能要求验证或暂时不可用，可换搜索引擎再试。', external: true };
    return { ok: true, summary: '找到 ' + results.length + ' 条搜索结果', data: results.map((r,i) => ({ index: i + 1, ...r })), external: true };
  }),
});

export const petWebRead = defineTool<{index: number}>({
  name: 'pet_web_read', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '在桌宠内置浏览器阅读上一次搜索结果中的指定条目，返回正文和实际来源网址。',
  inputSchema: { type: 'object', properties: { index: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['index'] },
  title: a => '阅读搜索结果 ' + a.index,
  execute: async (a, ctx) => exclusive(async () => {
    const url = sources.get(ctx.taskId)?.[a.index - 1];
    if (!url) return { ok: false, summary: '找不到这条结果', error: '请重新搜索并选择有效编号。' };
    const page = await visit(url, ctx.signal);
    const text: string = await page.executeJavaScriptInIsolatedWorld(999, [{code: "(document.querySelector('main,article') || document.body)?.innerText.trim().slice(0,10000) || ''"}]);
    if (!text) return { ok: false, summary: '网页没有可读正文', error: '可尝试其他来源。' };
    return { ok: true, summary: '已读取 ' + page.getTitle(), data: { url: page.getURL(), title: page.getTitle(), text }, external: true };
  }),
});

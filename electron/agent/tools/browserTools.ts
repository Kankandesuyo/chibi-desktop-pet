import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { defineTool, type AnyTool } from '../types';
import { normalizeUrl } from './appTools';
import { freeName } from './fileTools';

export interface BrowserOptions {
  /** A separate profile: the agent never touches the user's own browser logins. */
  profileDir: string;
  headless: boolean;
  executablePath?: string;
  channels: string[];
}

const CAPTCHA_RE = /captcha|recaptcha|hcaptcha|i'?m not a robot|人机验证|验证码|安全验证|滑动验证/i;

/** One Playwright browser shared by the browser_* tools, launched on first use and closed with the app. */
export class BrowserSession {
  private context: BrowserContext | null = null;
  private current = 0;
  private launching: Promise<BrowserContext> | null = null;

  constructor(private readonly options: () => BrowserOptions) {}

  private async ctx(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const { chromium } = await import('playwright-core');
      const o = this.options();
      fs.mkdirSync(o.profileDir, { recursive: true });
      const attempts = o.executablePath ? [{ executablePath: o.executablePath }] : o.channels.map((channel) => ({ channel }));
      let lastErr: unknown;
      for (const a of attempts) {
        try {
          const c = await chromium.launchPersistentContext(o.profileDir, { ...a, headless: o.headless, acceptDownloads: true, viewport: o.headless ? { width: 1280, height: 860 } : null });
          c.on('close', () => { this.context = null; });
          this.context = c;
          return c;
        } catch (err) { lastErr = err; }
      }
      throw new Error(`无法启动浏览器（需要安装 Microsoft Edge 或 Google Chrome）：${lastErr instanceof Error ? lastErr.message.split('\n')[0] : String(lastErr)}`);
    })();
    try { return await this.launching; } finally { this.launching = null; }
  }

  async page(): Promise<Page> {
    const c = await this.ctx();
    const pages = c.pages();
    if (pages.length === 0) { this.current = 0; return c.newPage(); }
    if (this.current >= pages.length) this.current = pages.length - 1;
    return pages[this.current] as Page;
  }

  async newPage(): Promise<Page> {
    const c = await this.ctx();
    const p = await c.newPage();
    this.current = c.pages().indexOf(p);
    return p;
  }

  async tabs(): Promise<{ index: number; title: string; url: string; current: boolean }[]> {
    if (!this.context) return [];
    return Promise.all(this.context.pages().map(async (p, i) => ({ index: i, title: await p.title().catch(() => ''), url: p.url(), current: i === this.current })));
  }

  async switchTo(i: number): Promise<Page> {
    const c = await this.ctx();
    const p = c.pages()[i];
    if (!p) throw new Error(`没有第 ${i} 个标签页`);
    this.current = i;
    await p.bringToFront();
    return p;
  }

  isOpen(): boolean { return this.context !== null; }

  async close(): Promise<void> {
    const c = this.context;
    this.context = null;
    await c?.close().catch(() => undefined);
  }
}

async function pageInfo(p: Page): Promise<{ title: string; url: string; captcha: boolean }> {
  const title = await p.title().catch(() => '');
  const text = await p.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  return { title, url: p.url(), captcha: CAPTCHA_RE.test(text.slice(0, 20_000)) || CAPTCHA_RE.test(title) };
}

/** Buttons that put something on the internet under the user's account. */
export const SEND_RE = /发布|发送|发表|评论|回复|提交|私信|分享到|post|send|publish|submit|reply|comment|tweet/i;

/**
 * Looks at what a click would press. A "发布 / 发送 / 评论…" button is high risk (always asks, never
 * "allow for the task"), and the card shows the text sitting in the page's input boxes, i.e. what will go out.
 */
async function assessClick(p: Page, a: { selector?: string; text?: string; role?: string; name?: string }): Promise<{ send: boolean; label: string; outgoing: string[] }> {
  const loc = locate(p, a);
  const info = await loc.evaluate((el) => {
    const e = el as HTMLElement;
    const label = [e.innerText, e.getAttribute('aria-label'), e.getAttribute('title'), (e as HTMLInputElement).value]
      .filter((x): x is string => !!x).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const boxes: string[] = [];
    document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable=""]').forEach((b) => {
      const v = (b instanceof HTMLTextAreaElement || b instanceof HTMLInputElement ? b.value : (b as HTMLElement).innerText).trim();
      const r = (b as HTMLElement).getBoundingClientRect();
      if (v && r.width > 0 && r.height > 0) boxes.push(v.slice(0, 300));
    });
    return { label, boxes: boxes.slice(0, 3) };
  }, undefined, { timeout: 5000 }).catch(() => null);
  const label = info?.label || a.name || a.text || a.selector || '';
  return { send: SEND_RE.test(label) || SEND_RE.test(a.name ?? '') || SEND_RE.test(a.text ?? ''), label, outgoing: info?.boxes ?? [] };
}

const captchaNote = '页面出现了验证码/人机验证：这需要用户本人完成，不能绕过。请告诉用户去浏览器里手动处理。';

function locate(p: Page, a: { selector?: string; text?: string; role?: string; name?: string; label?: string; placeholder?: string }) {
  if (a.selector) return p.locator(a.selector).first();
  if (a.role) return p.getByRole(a.role as Parameters<Page['getByRole']>[0], a.name ? { name: a.name } : undefined).first();
  if (a.label) return p.getByLabel(a.label).first();
  if (a.placeholder) return p.getByPlaceholder(a.placeholder).first();
  if (a.text) return p.getByText(a.text, { exact: false }).first();
  throw new Error('需要 selector、text、role、label 或 placeholder 之一');
}

const locatorProps = {
  selector: { type: 'string', maxLength: 300, description: 'CSS 选择器' },
  text: { type: 'string', maxLength: 200, description: '按可见文字定位' },
  role: { type: 'string', enum: ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem', 'option', 'searchbox'] },
  name: { type: 'string', maxLength: 200, description: '与 role 搭配：可访问名称' },
} as const;

const browserOpen = defineTool<{ url: string; newTab?: boolean }>({
  name: 'browser_open', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '在桌宠控制的浏览器（独立配置，不使用你自己浏览器的登录）里打开网页，之后可以点击、填写、提取内容。只是想让用户自己看网页时用 open_url。',
  inputSchema: { type: 'object', properties: { url: { type: 'string', maxLength: 2000 }, newTab: { type: 'boolean' } }, required: ['url'] },
  title: (a) => `浏览器打开 ${a.url}`,
  execute: async (a, ctx) => {
    const url = normalizeUrl(a.url);
    if (!url) return { ok: false, summary: '网址不合法', error: '只允许 http/https' };
    const p = a.newTab ? await ctx.services.browser.newPage() : await ctx.services.browser.page();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const info = await pageInfo(p);
    return { ok: true, summary: `已打开：${info.title || info.url}`, data: { ...info, notice: info.captcha ? captchaNote : undefined }, external: true };
  },
  verify: async (_a, _r, ctx) => { const p = await ctx.services.browser.page(); const ok = /^https?:/.test(p.url()); return { verified: ok, detail: ok ? `当前页面 ${p.url()}` : '页面没有打开' }; },
});

const ENGINES = {
  bing: { url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, sel: '#b_results li.b_algo h2 a' },
  baidu: { url: (q: string) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, sel: '#content_left h3 a' },
  google: { url: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`, sel: '#search a:has(h3)' },
} as const;

const browserSearch = defineTool<{ query: string; engine?: keyof typeof ENGINES }>({
  name: 'browser_search', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '用搜索引擎搜索并返回前 10 条结果（标题和链接）。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, engine: { type: 'string', enum: ['bing', 'baidu', 'google'], description: '默认 bing' } }, required: ['query'] },
  title: (a) => `搜索“${a.query}”`,
  execute: async (a, ctx) => {
    const e = ENGINES[a.engine ?? 'bing'];
    const p = await ctx.services.browser.page();
    await p.goto(e.url(a.query), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await p.waitForSelector(e.sel, { timeout: 8000 }).catch(() => undefined);
    const results = await p.$$eval(e.sel, (els) => els.slice(0, 10).map((el) => ({ title: (el.textContent ?? '').trim(), url: (el as HTMLAnchorElement).href || el.closest('a')?.href || '' })));
    const info = await pageInfo(p);
    return { ok: true, summary: `搜索到 ${results.length} 条结果`, data: { query: a.query, results, notice: info.captcha ? captchaNote : undefined }, external: true };
  },
});

const browserClick = defineTool<{ selector?: string; text?: string; role?: string; name?: string }>({
  name: 'browser_click', group: 'browser', riskLevel: 'medium', requiresConfirmation: false,
  description: '点击当前网页上的元素（按 CSS 选择器、可见文字或 role+name 定位）。可能提交表单，所以需要确认。',
  inputSchema: { type: 'object', properties: { ...locatorProps } },
  title: (a) => `点击网页上的“${a.text ?? a.name ?? a.selector}”`,
  assess: async (a, ctx) => {
    if (!ctx.services.browser.isOpen()) return { risk: 'medium' };
    const p = await ctx.services.browser.page();
    const c = await assessClick(p, a);
    if (!c.send) return { risk: 'medium', preview: [`按钮：${c.label}`, `页面：${p.url()}`] };
    return {
      risk: 'high',
      reason: '这一下会把内容以你的账号公开发出去（发布 / 发送 / 评论）。每一条都要你本人确认。',
      preview: [`按钮：${c.label}`, `网站：${new URL(p.url()).host}`, ...(c.outgoing.length ? c.outgoing.map((t) => `将发出：${t}`) : ['（页面输入框里没有找到文字，可能是发布视频或带附件）'])],
    };
  },
  execute: async (a, ctx) => {
    const p = await ctx.services.browser.page();
    await locate(p, a).click({ timeout: 10_000 });
    await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    const info = await pageInfo(p);
    return { ok: true, summary: `已点击，当前页面：${info.title || info.url}`, data: { ...info, notice: info.captcha ? captchaNote : undefined }, external: true };
  },
});

const browserFill = defineTool<{ selector?: string; label?: string; placeholder?: string; role?: string; name?: string; value: string }>({
  name: 'browser_fill', group: 'browser', riskLevel: 'medium', requiresConfirmation: false,
  description: '在网页输入框里填写内容（按选择器 / 标签文字 / placeholder 定位）。不会代填密码。',
  inputSchema: { type: 'object', properties: {
    selector: { type: 'string', maxLength: 300 }, label: { type: 'string', maxLength: 200 }, placeholder: { type: 'string', maxLength: 200 },
    role: { type: 'string', enum: ['textbox', 'searchbox', 'combobox'] }, name: { type: 'string', maxLength: 200 },
    value: { type: 'string', maxLength: 5000 },
  }, required: ['value'] },
  title: (a) => `在网页填写“${a.label ?? a.placeholder ?? a.name ?? a.selector}”`,
  assess: (a) => ({ risk: 'medium', preview: [`位置：${a.label ?? a.placeholder ?? a.name ?? a.selector}`, `内容：${a.value.slice(0, 200)}`] }),
  execute: async (a, ctx) => {
    const p = await ctx.services.browser.page();
    const loc = locate(p, a);
    const type = (await loc.getAttribute('type', { timeout: 10_000 }).catch(() => null))?.toLowerCase();
    if (type === 'password') return { ok: false, summary: '不会代填密码', error: '这是密码框。为了安全，密码需要你自己输入。' };
    await loc.fill(a.value, { timeout: 10_000 });
    return { ok: true, summary: '已填写' };
  },
  verify: async (a, _r, ctx) => {
    const v = await locate(await ctx.services.browser.page(), a).inputValue({ timeout: 5000 }).catch(() => null);
    return { verified: v === a.value, detail: v === a.value ? '输入框里的值正确' : '输入框里的值和预期不一致' };
  },
});

const browserExtract = defineTool<{ selector?: string; maxChars?: number; includeLinks?: boolean }>({
  name: 'browser_extract', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '读取当前网页（或某个元素）的文字内容，可选附带链接列表。',
  inputSchema: { type: 'object', properties: { selector: { type: 'string', maxLength: 300 }, maxChars: { type: 'integer', minimum: 200, maximum: 30_000 }, includeLinks: { type: 'boolean' } } },
  title: () => '读取网页内容',
  execute: async (a, ctx) => {
    const p = await ctx.services.browser.page();
    const text = await p.locator(a.selector ?? 'body').first().innerText({ timeout: 10_000 });
    const max = a.maxChars ?? 8000;
    const links = a.includeLinks ? await p.$$eval('a[href]', (els) => els.slice(0, 40).map((e) => ({ text: (e.textContent ?? '').trim().slice(0, 80), url: (e as HTMLAnchorElement).href }))) : undefined;
    const info = await pageInfo(p);
    return { ok: true, summary: `读取了 ${Math.min(text.length, max)} 字符`, data: { title: info.title, url: info.url, text: text.slice(0, max), truncated: text.length > max, links, notice: info.captcha ? captchaNote : undefined }, external: true };
  },
});

const browserTabs = defineTool<{ action: 'list' | 'switch' | 'close' | 'new'; index?: number; url?: string }>({
  name: 'browser_tabs', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '管理桌宠浏览器的标签页：list 列出、switch 切换、close 关闭、new 新开（可带 url）。',
  inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'switch', 'close', 'new'] }, index: { type: 'integer', minimum: 0, maximum: 50 }, url: { type: 'string', maxLength: 2000 } }, required: ['action'] },
  title: (a) => `标签页：${a.action}`,
  execute: async (a, ctx) => {
    const b = ctx.services.browser;
    if (a.action === 'new') {
      const p = await b.newPage();
      if (a.url) { const u = normalizeUrl(a.url); if (!u) return { ok: false, summary: '网址不合法', error: '只允许 http/https' }; await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    } else if (a.action === 'switch') {
      if (a.index === undefined) return { ok: false, summary: '缺少 index', error: '需要 index' };
      await b.switchTo(a.index);
    } else if (a.action === 'close') {
      const p = a.index === undefined ? await b.page() : await b.switchTo(a.index);
      await p.close();
    }
    const tabs = await b.tabs();
    return { ok: true, summary: `共有 ${tabs.length} 个标签页`, data: tabs, external: true };
  },
});

const browserDownload = defineTool<{ selector?: string; text?: string; role?: string; name?: string }>({
  name: 'browser_download', group: 'browser', riskLevel: 'medium', requiresConfirmation: false,
  description: '点击网页上的下载链接/按钮并把文件保存到“下载”文件夹。',
  inputSchema: { type: 'object', properties: { ...locatorProps } },
  title: (a) => `下载“${a.text ?? a.name ?? a.selector}”`,
  paths: (_a, ctx) => ({ write: [ctx.platform.knownFolders().downloads] }),
  execute: async (a, ctx) => {
    const p = await ctx.services.browser.page();
    const [download] = await Promise.all([p.waitForEvent('download', { timeout: 60_000 }), locate(p, a).click({ timeout: 10_000 })]);
    const dest = freeName(path.join(ctx.platform.knownFolders().downloads, path.basename(download.suggestedFilename() || 'download')));
    await download.saveAs(dest);
    return { ok: true, summary: `已下载到 ${dest}`, data: { path: dest, from: download.url() } };
  },
  verify: async (_a, r) => { const f = (r.data as { path: string }).path; const ok = fs.existsSync(f) && fs.statSync(f).size > 0; return { verified: ok, detail: ok ? '文件已保存' : '没有找到下载的文件' }; },
});

const browserUpload = defineTool<{ selector?: string; path: string }>({
  name: 'browser_upload_file', group: 'browser', riskLevel: 'medium', requiresConfirmation: true,
  description: '把本机的一个文件（例如要发的视频、封面图）放进网页的上传框（input[type=file]）。只是选好文件，不会发布；发布要再点发布按钮，那一步会单独确认。',
  inputSchema: { type: 'object', properties: {
    selector: { type: 'string', maxLength: 300, description: '上传框的 CSS 选择器，默认 input[type=file]' },
    path: { type: 'string', maxLength: 1000 },
  }, required: ['path'] },
  title: (a) => `把 ${path.basename(a.path)} 放进网页上传框`,
  paths: (a, ctx) => ({ read: [ctx.resolvePath(a.path)] }),
  assess: (a, ctx) => ({ risk: 'medium', preview: [`文件：${ctx.resolvePath(a.path)}`, '只选文件，不会发布'] }),
  execute: async (a, ctx) => {
    const file = ctx.resolvePath(a.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, summary: '文件不存在', error: `找不到文件：${file}` };
    const p = await ctx.services.browser.page();
    await p.locator(a.selector ?? 'input[type=file]').first().setInputFiles(file, { timeout: 15_000 });
    return { ok: true, summary: `已选好 ${path.basename(file)}`, external: true };
  },
});

const browserClose = defineTool<Record<string, never>>({
  name: 'browser_close', group: 'browser', riskLevel: 'low', requiresConfirmation: false,
  description: '关闭桌宠控制的浏览器。',
  inputSchema: { type: 'object', properties: {} },
  title: () => '关闭浏览器',
  execute: async (_a, ctx) => { await ctx.services.browser.close(); return { ok: true, summary: '浏览器已关闭' }; },
});

export const browserTools: AnyTool[] = [browserOpen, browserSearch, browserClick, browserFill, browserExtract, browserTabs, browserDownload, browserUpload, browserClose];

import { ipcMain, shell, WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron';
import type { BrowserPaneAction, BrowserPaneState } from '../shared/types';
import { researchSession, setPetBrowserHost } from './agent/tools/petWeb';
import type { WindowManager } from './windowManager';

const CLOSED: BrowserPaneState = { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [], active: 0 };
const httpUrl = (u: string): boolean => /^https?:\/\//i.test(u);
const CHROME = process.versions.chrome ?? '130.0.0.0';
/** Clean browser identities (no "Electron" in them): desktop for a wide pane, phone for a narrow one. */
const DESKTOP_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`;
const MOBILE_UA = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Mobile Safari/537.36`;
/** Below this pane width (DIP) pages are loaded in their mobile layout, which fits any width. */
const NARROW = 800;
/** Desktop pages are zoomed out at most this far to fit (mobile layouts down to 0.5). Never reloads to fit. */
const MIN_DESKTOP_ZOOM = 0.67;
/** More tabs than this and the oldest inactive one is closed. */
const MAX_TABS = 12;
/** Where the window says the pane is, and whether the page should show (not on the start / error page). */
export interface PaneBounds extends Rectangle { show: boolean }

interface Tab {
  id: number;
  view: WebContentsView;
  /** Why the last page failed to load (shown by the window instead of an empty pane). */
  error: string;
  mobile: boolean;
  fitWidth: number;
  fitTimer: NodeJS.Timeout | null;
}

/**
 * The built-in browser, shown as a pane inside the main window (like Codex / Claude), with tabs. Each tab is a
 * WebContentsView; only the active one is in the window, laid over the area the page reserves for it. Her
 * browser tools (pet_web_search, browser_open…) use the active tab; the user can browse too. Pages run in the
 * isolated research session and are never trusted for IPC.
 */
export class BrowserPane {
  private tabs: Tab[] = [];
  private activeId = 0;
  private nextId = 1;
  private host: BrowserWindow | null = null;
  /** The view currently placed in `host`. */
  private attached: WebContentsView | null = null;
  private bounds: Rectangle | null = null;
  /** The window wants the page shown (false on the start page, the error page and while dragging). */
  private show = false;
  /** Last known pane width, so the layout is chosen right even while the page is hidden. */
  private lastWidth = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly windows: WindowManager) {}

  private active(): Tab | null { return this.tabs.find((t) => t.id === this.activeId) ?? null; }

  state(): BrowserPaneState {
    const tab = this.active();
    const wc = tab?.view.webContents;
    if (!tab || !wc || wc.isDestroyed()) return CLOSED;
    return {
      open: true, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoadingMainFrame(),
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
      ...(tab.error ? { error: tab.error } : {}),
      tabs: this.tabs.filter((t) => !t.view.webContents.isDestroyed()).map((t) => ({
        id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), loading: t.view.webContents.isLoadingMainFrame(),
      })),
      active: tab.id,
    };
  }

  private tell(): void { this.windows.mainWindow()?.webContents.send('evt:browser', this.state()); }

  /**
   * Opens the pane (and the main window) and returns the active tab's page once it has a place on screen
   * (a new tab if there is none). Her tools call this before loading a page.
   */
  async contents(waitForPlace = true): Promise<WebContents> {
    this.windows.openPanel('chat', 'chat');
    const win = this.windows.mainWindow();
    if (!win) throw new Error('主窗口没有打开');
    if (!this.active()) this.newTab();
    this.attach(win);
    this.tell();
    // Wait (briefly) for the page to lay the pane out; until then it sits on the right half.
    if (waitForPlace && !this.bounds) await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 1500); });
    this.place();
    const tab = this.active() as Tab;
    this.pickLayout(tab);
    return tab.view.webContents;
  }

  /** A fresh tab for her tools (browser_open with newTab). */
  async newTabContents(): Promise<WebContents> {
    if (this.tabs.length) this.newTab();
    return this.contents();
  }

  /** Desktop or mobile layout for the next page, by how wide the pane is now. */
  private pickLayout(tab: Tab): void {
    const width = this.lastWidth || Math.round((this.host?.getContentSize()[0] ?? 1200) / 2);
    const narrow = width < NARROW;
    const wc = tab.view.webContents;
    if (narrow === tab.mobile && wc.getUserAgent() === (narrow ? MOBILE_UA : DESKTOP_UA)) return;
    tab.mobile = narrow;
    wc.setUserAgent(narrow ? MOBILE_UA : DESKTOP_UA);
  }

  private newTab(url?: string): Tab {
    const view = new WebContentsView({ webPreferences: { session: researchSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const wc = view.webContents;
    view.setBackgroundColor('#ffffff');
    const tab: Tab = { id: this.nextId++, view, error: '', mobile: false, fitWidth: 0, fitTimer: null };
    // Links that want a new window open as a new tab; nothing but http(s).
    wc.setWindowOpenHandler(({ url: target }) => { if (httpUrl(target)) { this.newTab(target); this.tell(); } return { action: 'deny' }; });
    wc.on('will-navigate', (event, target) => { if (!httpUrl(target)) event.preventDefault(); });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) wc.on(ev as 'did-start-loading', () => this.tell());
    // Fit the page to the pane: as soon as it can be laid out, and again when it has finished loading.
    wc.on('dom-ready', () => this.scheduleFit(tab, 0));
    wc.on('did-finish-load', () => this.scheduleFit(tab, 300));
    // A page that cannot load says why (instead of a dark, empty pane); a new navigation clears it.
    wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument && tab.error) { tab.error = ''; this.tell(); } });
    wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;                         // -3 = aborted by a newer navigation
      tab.error = `${description || '无法打开网页'} (${code})${failedUrl ? ` · ${failedUrl}` : ''}`;
      this.tell();
    });
    wc.on('render-process-gone', () => { tab.error = '网页进程意外退出了，点「重试」重新打开'; this.tell(); });
    this.tabs.push(tab);
    // Too many tabs: drop the oldest one that is not showing.
    if (this.tabs.length > MAX_TABS) { const old = this.tabs.find((t) => t.id !== this.activeId && t !== tab); if (old) this.destroy(old); }
    this.activeId = tab.id;
    if (url && httpUrl(url)) { this.pickLayout(tab); void wc.loadURL(url); }
    if (this.host) this.attach(this.host);
    return tab;
  }

  private activate(id: number): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.activeId = id;
    if (this.host) this.attach(this.host);
    this.tell();
  }

  /** Puts the active tab's view into the window (and takes the previous one out). */
  private attach(win: BrowserWindow): void {
    const view = this.active()?.view ?? null;
    if (this.host !== win) {
      if (this.host && !this.host.isDestroyed() && this.attached) this.host.contentView.removeChildView(this.attached);
      this.attached = null;
      this.host = win;
      win.once('closed', () => { if (this.host === win) { this.host = null; this.attached = null; this.bounds = null; } });
    }
    if (this.attached !== view) {
      if (this.attached && !win.isDestroyed()) win.contentView.removeChildView(this.attached);
      if (view) win.contentView.addChildView(view);
      this.attached = view;
    }
    this.place();
  }

  private place(): void {
    const v = this.attached;
    const win = this.host;
    if (!v || !win || win.isDestroyed()) return;
    if (this.show && this.bounds && this.bounds.width > 20 && this.bounds.height > 20) {
      v.setBounds(this.bounds); v.setVisible(true);
    } else if (this.bounds === null && this.waiters.length && v.webContents.getURL()) {
      const [w, h] = win.getContentSize();
      v.setBounds({ x: Math.round((w as number) / 2), y: 40, width: Math.round((w as number) / 2), height: (h as number) - 40 }); v.setVisible(true);
    } else v.setVisible(false);
  }

  /** The window says where the pane is (CSS px = DIP at zoom 1) and whether to show the page; null = gone. */
  setBounds(b: PaneBounds | null): void {
    this.bounds = b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
    this.show = !!b?.show;
    if (this.bounds && this.bounds.width > 20) this.lastWidth = this.bounds.width;
    if (b) for (const w of this.waiters.splice(0)) w();
    this.place();
    // The pane got wider or narrower: fit the visible tab again (debounced while the divider is dragged).
    const tab = this.active();
    if (tab && this.show && this.bounds && Math.abs(this.bounds.width - tab.fitWidth) > 8) this.scheduleFit(tab, 200);
  }

  private scheduleFit(tab: Tab, ms: number): void {
    if (tab.fitTimer) clearTimeout(tab.fitTimer);
    tab.fitTimer = setTimeout(() => { tab.fitTimer = null; void this.fit(tab); }, ms);
  }

  /**
   * Adapts the active page to the pane's width: pages that fit stay at 100%; wider ones are zoomed out just
   * enough (desktop to 67%, mobile to 50%). Measured at 100% first, so a wider pane zooms back in.
   */
  private async fit(tab: Tab): Promise<void> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || tab.id !== this.activeId || !this.bounds || !this.show || !/^https?:/i.test(wc.getURL())) return;
    tab.fitWidth = this.bounds.width;
    const measure = async (): Promise<{ sw: number; iw: number } | null> => {
      try {
        return await wc.executeJavaScriptInIsolatedWorld(998, [{ code: '({ sw: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), iw: window.innerWidth })' }]) as { sw: number; iw: number };
      } catch { return null; }
    };
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120));
    if (wc.getZoomFactor() !== 1) { wc.setZoomFactor(1); await settle(); }
    for (let i = 0; i < 3; i++) {
      if (wc.isDestroyed()) return;
      const m = await measure();
      if (!m || m.iw <= 0 || m.sw <= m.iw + 2) return;
      const z = Math.max(tab.mobile ? 0.5 : MIN_DESKTOP_ZOOM, Math.min(1, wc.getZoomFactor() * (m.iw / m.sw)));
      if (Math.abs(z - wc.getZoomFactor()) < 0.01) return;
      wc.setZoomFactor(Math.floor(z * 100) / 100);
      await settle();
    }
  }

  private destroy(tab: Tab): void {
    if (tab.fitTimer) clearTimeout(tab.fitTimer);
    if (this.attached === tab.view) {
      if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(tab.view);
      this.attached = null;
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tabs = this.tabs.filter((t) => t !== tab);
  }

  /** Closes one tab; the neighbour becomes active. Closing the last tab closes the pane. */
  private closeTab(id: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const wasActive = this.tabs[i]?.id === this.activeId;
    this.destroy(this.tabs[i] as Tab);
    if (!this.tabs.length) { this.close(); return; }
    if (wasActive) this.activeId = (this.tabs[Math.min(i, this.tabs.length - 1)] as Tab).id;
    if (this.host) this.attach(this.host);
    this.tell();
  }

  close(): void {
    for (const t of [...this.tabs]) this.destroy(t);
    this.tabs = [];
    this.activeId = 0;
    this.bounds = null;
    this.show = false;
    this.tell();
  }

  async control(a: BrowserPaneAction): Promise<BrowserPaneState> {
    // Without a URL the pane opens on its start page (drawn by the window; the native view stays hidden).
    if (a.type === 'open') { const wc = await this.contents(!!a.url); if (a.url && httpUrl(a.url)) void wc.loadURL(a.url); return this.state(); }
    if (a.type === 'close') { this.close(); return this.state(); }
    if (a.type === 'newTab') {
      if (!this.tabs.length) { const wc = await this.contents(!!a.url); if (a.url && httpUrl(a.url)) void wc.loadURL(a.url); return this.state(); }
      this.newTab(a.url); this.tell(); return this.state();
    }
    if (a.type === 'switchTab') { this.activate(a.id); return this.state(); }
    if (a.type === 'closeTab') { this.closeTab(a.id); return this.state(); }
    const tab = this.active();
    const wc = tab?.view.webContents;
    if (!tab || !wc || wc.isDestroyed()) return this.state();
    if (a.type === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (a.type === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (a.type === 'reload') { if (wc.isLoading()) wc.stop(); else { tab.error = ''; wc.reload(); } }
    else if (a.type === 'navigate' && a.url) {
      this.pickLayout(tab);
      const raw = a.url.trim();
      const url = httpUrl(raw) ? raw : /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(raw) ? `https://${raw}` : `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
      void wc.loadURL(url);
    } else if (a.type === 'external' && httpUrl(wc.getURL())) void shell.openExternal(wc.getURL());
    return this.state();
  }
}

/** IPC for the pane; only the main window may drive it. */
export function registerBrowserPane(windows: WindowManager): BrowserPane {
  const pane = new BrowserPane(windows);
  const fromMain = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => e.sender.id === windows.mainWindow()?.webContents.id;
  ipcMain.on('browser:bounds', (e, b: PaneBounds | null) => {
    if (!fromMain(e)) return;
    const ok = b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n));
    pane.setBounds(ok ? { x: b.x, y: b.y, width: b.width, height: b.height, show: b.show !== false } : null);
  });
  ipcMain.handle('browser:control', (e, a: BrowserPaneAction) => (fromMain(e) && a && typeof a.type === 'string' ? pane.control(a) : pane.state()));
  ipcMain.handle('browser:state', () => pane.state());
  setPetBrowserHost({ contents: () => pane.contents(), newTab: () => pane.newTabContents(), close: () => pane.close() });
  return pane;
}

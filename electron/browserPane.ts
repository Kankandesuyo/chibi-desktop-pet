import { ipcMain, shell, WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron';
import type { BrowserPaneAction, BrowserPaneState } from '../shared/types';
import { researchSession, setPetBrowserHost } from './agent/tools/petWeb';
import type { WindowManager } from './windowManager';

const CLOSED: BrowserPaneState = { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
const httpUrl = (u: string): boolean => /^https?:\/\//i.test(u);
const CHROME = process.versions.chrome ?? '130.0.0.0';
/** Clean browser identities (no "Electron" in them): desktop for a wide pane, phone for a narrow one. */
const DESKTOP_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`;
const MOBILE_UA = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Mobile Safari/537.36`;
/** Below this pane width (DIP) pages are loaded in their mobile layout, which fits any width. */
const NARROW = 800;
/** Desktop pages are zoomed out at most this far to fit (mobile layouts down to 0.5). Never reloads to fit. */
const MIN_DESKTOP_ZOOM = 0.67;
/** Where the window says the pane is, and whether the page should show (not on the start / error page). */
export interface PaneBounds extends Rectangle { show: boolean }

/**
 * The built-in browser, shown as a pane inside the main window (like Codex / Claude): a WebContentsView laid
 * over the area the page reserves for it. Her browser tools (pet_web_search, browser_open…) load pages here;
 * the user can browse in it too. Pages run in the isolated research session and are never trusted for IPC.
 */
export class BrowserPane {
  private view: WebContentsView | null = null;
  private host: BrowserWindow | null = null;
  private bounds: Rectangle | null = null;
  /** The window wants the page shown (false on the start page, the error page and while dragging). */
  private show = false;
  /** Last known pane width, so the layout is chosen right even while the page is hidden. */
  private lastWidth = 0;
  /** Why the last page failed to load (shown by the window instead of an empty pane). */
  private error = '';
  private waiters: (() => void)[] = [];
  private fitTimer: NodeJS.Timeout | null = null;
  private fitWidth = 0;

  constructor(private readonly windows: WindowManager) {}

  state(): BrowserPaneState {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return CLOSED;
    return {
      open: true, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoadingMainFrame(),  // not background frames
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private tell(): void { this.windows.mainWindow()?.webContents.send('evt:browser', this.state()); }

  /** Opens the pane (and the main window) and returns the page's web contents once it has a place on screen. */
  async contents(waitForPlace = true): Promise<WebContents> {
    this.windows.openPanel('chat', 'chat');
    const win = this.windows.mainWindow();
    if (!win) throw new Error('主窗口没有打开');
    if (!this.view || this.view.webContents.isDestroyed()) this.create();
    this.attach(win);
    this.tell();
    // Wait (briefly) for the page to lay the pane out; until then it sits on the right half.
    if (waitForPlace && !this.bounds) await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 1500); });
    this.place();
    const wc = (this.view as WebContentsView).webContents;
    this.pickLayout(wc);
    return wc;
  }

  private mobile = false;
  /** Desktop or mobile layout for the next page, by how wide the pane is now. */
  private pickLayout(wc: WebContents, force?: boolean): void {
    const width = this.lastWidth || Math.round((this.host?.getContentSize()[0] ?? 1200) / 2);
    const narrow = force ?? width < NARROW;
    if (narrow === this.mobile && wc.getUserAgent() === (narrow ? MOBILE_UA : DESKTOP_UA)) return;
    this.mobile = narrow;
    wc.setUserAgent(narrow ? MOBILE_UA : DESKTOP_UA);
  }

  private create(): void {
    const view = new WebContentsView({ webPreferences: { session: researchSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const wc = view.webContents;
    view.setBackgroundColor('#ffffff');
    // Pop-ups open in the pane itself; nothing but http(s).
    wc.setWindowOpenHandler(({ url }) => { if (httpUrl(url)) void wc.loadURL(url); return { action: 'deny' }; });
    wc.on('will-navigate', (event, url) => { if (!httpUrl(url)) event.preventDefault(); });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) wc.on(ev as 'did-start-loading', () => this.tell());
    // Fit the page to the pane: as soon as it can be laid out, and again when it has finished loading.
    wc.on('dom-ready', () => this.scheduleFit(0));
    // A page that cannot load says why (instead of a dark, empty pane); a new navigation clears it.
    wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument && this.error) { this.error = ''; this.tell(); } });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;                         // -3 = aborted by a newer navigation
      this.error = `${description || '无法打开网页'} (${code})${url ? ` · ${url}` : ''}`;
      this.tell();
    });
    wc.on('render-process-gone', () => { this.error = '网页进程意外退出了，点「重试」重新打开'; this.tell(); });
    wc.on('did-finish-load', () => this.scheduleFit(300));
    this.view = view;
  }

  private attach(win: BrowserWindow): void {
    if (!this.view) return;
    if (this.host !== win) {
      if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(this.view);
      win.contentView.addChildView(this.view);
      this.host = win;
      win.once('closed', () => { if (this.host === win) { this.host = null; this.bounds = null; } });
    }
    this.place();
  }

  private place(): void {
    const v = this.view;
    const win = this.host;
    if (!v || !win || win.isDestroyed()) return;
    if (this.show && this.bounds && this.bounds.width > 20 && this.bounds.height > 20) {
      v.setBounds(this.bounds); v.setVisible(true);
    } else if (this.bounds === null && this.waiters.length && this.view?.webContents.getURL()) {
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
    // The pane got wider or narrower: fit again (debounced while the divider is dragged).
    if (this.show && this.bounds && Math.abs(this.bounds.width - this.fitWidth) > 8) this.scheduleFit(200);
  }

  private scheduleFit(ms: number): void {
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => { this.fitTimer = null; void this.fit(); }, ms);
  }

  /**
   * Adapts the page to the pane's width: pages that fit stay at 100%; pages with a fixed minimum width (many
   * desktop sites) are zoomed out just enough to fit, down to 50%, instead of being cut off with a sideways
   * scrollbar. Measured at 100% first, so a wider pane zooms back in.
   */
  private async fit(): Promise<void> {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed() || !this.bounds || !this.show || !/^https?:/i.test(wc.getURL())) return;
    this.fitWidth = this.bounds.width;
    const measure = async (): Promise<{ sw: number; iw: number } | null> => {
      try {
        return await wc.executeJavaScriptInIsolatedWorld(998, [{ code: '({ sw: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), iw: window.innerWidth })' }]) as { sw: number; iw: number };
      } catch { return null; }
    };
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120));
    if (wc.getZoomFactor() !== 1) { wc.setZoomFactor(1); await settle(); }
    for (let i = 0; i < 3; i++) {
      const m = await measure();
      if (!m || m.iw <= 0 || m.sw <= m.iw + 2) return;
      const z = Math.max(this.mobile ? 0.5 : MIN_DESKTOP_ZOOM, Math.min(1, wc.getZoomFactor() * (m.iw / m.sw)));
      if (Math.abs(z - wc.getZoomFactor()) < 0.01) return;
      wc.setZoomFactor(Math.floor(z * 100) / 100);
      await settle();
    }
  }

  close(): void {
    const v = this.view;
    this.view = null;
    this.bounds = null;
    this.show = false;
    this.error = '';
    if (v) {
      if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(v);
      if (!v.webContents.isDestroyed()) v.webContents.close();
    }
    this.tell();
  }

  async control(a: BrowserPaneAction): Promise<BrowserPaneState> {
    // Without a URL the pane opens on its start page (drawn by the window; the native view stays hidden).
    if (a.type === 'open') { const wc = await this.contents(!!a.url); if (a.url && httpUrl(a.url)) void wc.loadURL(a.url); return this.state(); }
    const wc = this.view?.webContents;
    if (a.type === 'close') { this.close(); return this.state(); }
    if (!wc || wc.isDestroyed()) return this.state();
    if (a.type === 'blank') void wc.loadURL('about:blank');
    else if (a.type === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (a.type === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (a.type === 'reload') { if (wc.isLoading()) wc.stop(); else { this.error = ''; wc.reload(); } }
    else if (a.type === 'navigate' && a.url) {
      this.pickLayout(wc);
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
  setPetBrowserHost({ contents: () => pane.contents(), close: () => pane.close() });
  return pane;
}

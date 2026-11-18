import { ipcMain, shell, WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron';
import type { BrowserPaneAction, BrowserPaneState } from '../shared/types';
import { researchSession, setPetBrowserHost } from './agent/tools/petWeb';
import type { WindowManager } from './windowManager';

const CLOSED: BrowserPaneState = { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
const httpUrl = (u: string): boolean => /^https?:\/\//i.test(u);

/**
 * The built-in browser, shown as a pane inside the main window (like Codex / Claude): a WebContentsView laid
 * over the area the page reserves for it. Her browser tools (pet_web_search, browser_open…) load pages here;
 * the user can browse in it too. Pages run in the isolated research session and are never trusted for IPC.
 */
export class BrowserPane {
  private view: WebContentsView | null = null;
  private host: BrowserWindow | null = null;
  private bounds: Rectangle | null = null;
  private waiters: (() => void)[] = [];

  constructor(private readonly windows: WindowManager) {}

  state(): BrowserPaneState {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return CLOSED;
    return {
      open: true, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
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
    return (this.view as WebContentsView).webContents;
  }

  private create(): void {
    const view = new WebContentsView({ webPreferences: { session: researchSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const wc = view.webContents;
    view.setBackgroundColor('#ffffff');
    // Pop-ups open in the pane itself; nothing but http(s).
    wc.setWindowOpenHandler(({ url }) => { if (httpUrl(url)) void wc.loadURL(url); return { action: 'deny' }; });
    wc.on('will-navigate', (event, url) => { if (!httpUrl(url)) event.preventDefault(); });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) wc.on(ev as 'did-start-loading', () => this.tell());
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
    if (this.bounds && this.bounds.width > 20 && this.bounds.height > 20) {
      v.setBounds(this.bounds); v.setVisible(true);
    } else if (this.bounds === null && this.waiters.length && this.view?.webContents.getURL()) {
      const [w, h] = win.getContentSize();
      v.setBounds({ x: Math.round((w as number) / 2), y: 40, width: Math.round((w as number) / 2), height: (h as number) - 40 }); v.setVisible(true);
    } else v.setVisible(false);
  }

  /** The page says where the pane is (CSS px = DIP at zoom 1), or null when it is not shown. */
  setBounds(b: Rectangle | null): void {
    this.bounds = b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
    if (b) for (const w of this.waiters.splice(0)) w();
    this.place();
  }

  close(): void {
    const v = this.view;
    this.view = null;
    this.bounds = null;
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
    else if (a.type === 'reload') { if (wc.isLoading()) wc.stop(); else wc.reload(); }
    else if (a.type === 'navigate' && a.url) {
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
  ipcMain.on('browser:bounds', (e, b: Rectangle | null) => {
    if (!fromMain(e)) return;
    const ok = b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n));
    pane.setBounds(ok ? b : null);
  });
  ipcMain.handle('browser:control', (e, a: BrowserPaneAction) => (fromMain(e) && a && typeof a.type === 'string' ? pane.control(a) : pane.state()));
  ipcMain.handle('browser:state', () => pane.state());
  setPetBrowserHost({ contents: () => pane.contents(), close: () => pane.close() });
  return pane;
}

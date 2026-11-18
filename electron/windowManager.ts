import { BrowserWindow, nativeTheme, screen, type Display } from 'electron';
import * as path from 'node:path';
import {
  CHARACTER_HALF_WIDTH, CHARACTER_HEIGHT, FOOT_MARGIN, IPC, windowSizeFor,
} from '../shared/constants';
import type { ChatCompose } from '../shared/fileDrop';
import type { DragUpdate, PanelState, PetPlacement, Point, Rect } from '../shared/types';
import type { ConfigStore } from './configStore';

export type PanelView = 'chat' | 'settings';
/** How long the ring stays on screen. */
const HIGHLIGHT_MS = 11000;

/**
 * Z-order level for "stay on top". On Windows Electron puts 'floating' (and status, main-menu, ...) windows
 * just behind the taskbar and redoes that on every move, which the walking pet does many times a second;
 * in practice the window then loses its topmost flag. 'screen-saver' is a plain topmost window.
 */
export const ON_TOP_LEVEL = 'screen-saver';
/** How often to check that Windows (or another app) has not demoted the pet from topmost. */
const ON_TOP_CHECK_MS = 3000;
/** Cursor poll for file drags (see pollCursor). Cheap: one cursor read, IPC only while over the window. */
const CURSOR_POLL_MS = 40;

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const LIGHT_BG = '#f7f4f0';
const DARK_BG = '#1c1b1a';
/** Colours of the native window buttons drawn over the page's own title bar (40 px tall). */
function titleBarColors(dark: boolean): Electron.TitleBarOverlayOptions {
  return dark ? { color: '#00000000', symbolColor: '#e8e4df', height: 40 } : { color: '#00000000', symbolColor: '#3a3632', height: 40 };
}
export const APP_ORIGIN = 'app://local';

function pageUrl(view: 'pet' | 'highlight' | PanelView): string {
  return `${DEV_URL ?? APP_ORIGIN}/index.html#${view}`;
}

/** Keeps the pet's feet inside a work area so she can never end up unreachable off-screen. */
export function clampFeet(feet: Point, wa: Rect, size: number): Point {
  const half = CHARACTER_HALF_WIDTH * size;
  const tall = CHARACTER_HEIGHT * size;
  return {
    x: Math.round(Math.min(wa.x + wa.width - half, Math.max(wa.x + half, feet.x))),
    y: Math.round(Math.min(wa.y + wa.height, Math.max(wa.y + tall, feet.y))),
  };
}

/** Owns every BrowserWindow: the transparent pet window plus the chat / settings panels. */
export class WindowManager {
  pet: BrowserWindow | null = null;
  /** Main window "stay on top" (the pin button). */
  private chatPinned = false;
  private feet: Point = { x: 0, y: 0 };
  private dragTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private onTopTimer: NodeJS.Timeout | null = null;
  private highlight: BrowserWindow | null = null;
  private highlightTimer: NodeJS.Timeout | null = null;
  private highlightId = 0;
  private cursorTimer: NodeJS.Timeout | null = null;
  private lastCursor: string | null = null;
  /** "Do something with these files", waiting for the chat window to pick it up. */
  private pendingCompose: ChatCompose | null = null;

  constructor(private readonly config: ConfigStore) {}

  /**
   * Tells the pet window where the cursor is while it is over the window. Normally the forwarded mouse
   * moves do this, but while the user drags a file from Explorer Windows sends none, so without this she
   * would stay click-through and could never become a drop target.
   */
  private pollCursor(): void {
    const win = this.pet;
    if (!win || win.isDestroyed() || !win.isVisible() || this.dragTimer) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
    const key = inside ? `${p.x - b.x},${p.y - b.y}` : null;
    if (key === this.lastCursor) return;
    this.lastCursor = key;
    win.webContents.send(IPC.cursor, inside ? { x: p.x - b.x, y: p.y - b.y } : null);
  }

  /** Opens (or brings forward) the chat with the cursor in its input box. */
  focusChat(): void {
    this.openPanel('chat');
    const win = this.main;
    if (!win || win.isDestroyed()) return;
    win.focus();
    // A freshly created chat focuses its input by itself once loaded.
    if (!win.webContents.isLoading()) win.webContents.send(IPC.chatFocus);
  }

  /** Opens the chat and hands it a request about dropped files (it fetches it with takeCompose). */
  composeInChat(c: ChatCompose): void {
    this.pendingCompose = c;
    this.openPanel('chat');
    const win = this.main;
    // A freshly created chat takes it itself once loaded; an open one is told now.
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send(IPC.chatCompose);
  }

  takeCompose(webContentsId: number): ChatCompose | null {
    const win = this.main;
    if (!win || win.isDestroyed() || win.webContents.id !== webContentsId) return null;
    const c = this.pendingCompose;
    this.pendingCompose = null;
    return c;
  }

  private get size(): number { return this.config.getSettings().size; }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    };
  }

  private displayFor(point: Point): Display { return screen.getDisplayNearestPoint(point); }

  createPetWindow(): BrowserWindow {
    const settings = this.config.getSettings();
    const primary = screen.getPrimaryDisplay().workArea;
    const saved = this.config.getFeet();
    const start = saved ?? { x: primary.x + primary.width - 220, y: primary.y + primary.height };
    this.feet = clampFeet(start, this.displayFor(start).workArea, settings.size);
    const bounds = this.boundsFor(this.feet);

    const win = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: settings.alwaysOnTop,
      backgroundColor: '#00000000',
      webPreferences: this.webPreferences(),
    });
    if (settings.alwaysOnTop) win.setAlwaysOnTop(true, ON_TOP_LEVEL);
    win.setOpacity(settings.opacity);
    // Start click-through; the renderer turns capturing on only while the cursor is over the character.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => {
      this.pet = null; this.stopDrag();
      if (this.onTopTimer) clearInterval(this.onTopTimer);
      if (this.cursorTimer) clearInterval(this.cursorTimer);
    });
    this.cursorTimer = setInterval(() => this.pollCursor(), CURSOR_POLL_MS);
    void win.loadURL(pageUrl('pet'));
    this.pet = win;

    // Keep her on top when the setting says so: re-assert right away if something demotes the window,
    // and check now and then because Windows does not always report it.
    win.on('always-on-top-changed', (_e, onTop) => { if (!onTop) setImmediate(() => this.keepOnTop()); });
    this.onTopTimer = setInterval(() => this.keepOnTop(), ON_TOP_CHECK_MS);

    const recheck = (): void => this.recorrectPosition();
    screen.on('display-metrics-changed', recheck);
    screen.on('display-removed', recheck);
    screen.on('display-added', recheck);
    win.on('closed', () => {
      screen.off('display-metrics-changed', recheck);
      screen.off('display-removed', recheck);
      screen.off('display-added', recheck);
    });
    return win;
  }

  private boundsFor(feet: Point): Rect {
    const { width, height } = windowSizeFor(this.size);
    return {
      x: Math.round(feet.x - width / 2),
      y: Math.round(feet.y - (height - FOOT_MARGIN * this.size)),
      width,
      height,
    };
  }

  getPlacement(): PetPlacement {
    return { feet: { ...this.feet }, workArea: this.displayFor(this.feet).workArea };
  }

  private applyFeet(feet: Point): void {
    this.feet = feet;
    // Always pass width/height too: on mixed-DPI setups setPosition alone lets the window size drift.
    if (this.pet && !this.pet.isDestroyed()) this.pet.setBounds(this.boundsFor(feet), false);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.config.setFeet(this.feet), 600);
  }

  /** Renderer-driven movement (walking, falling). The work area is that of the display she is on. */
  moveTo(target: Point): void {
    if (this.dragTimer) return;                       // while dragging, the cursor is in charge
    const wa = this.displayFor(this.feet).workArea;
    this.applyFeet(clampFeet(target, wa, this.size));
  }

  /** Where the cursor is. Replaceable so the smoke test can script a drag without a real mouse. */
  cursorProvider: () => Point = () => screen.getCursorScreenPoint();

  /** Dragging: main follows the real cursor (correct on any DPI) and reports position + velocity back. */
  startDrag(): void {
    if (!this.pet || this.dragTimer) return;
    const cursor = this.cursorProvider();
    const offset = { x: cursor.x - this.feet.x, y: cursor.y - this.feet.y };
    let last = { ...this.feet };
    let lastTime = Date.now();
    let vx = 0;
    let vy = 0;
    this.dragTimer = setInterval(() => {
      if (!this.pet || this.pet.isDestroyed()) { this.stopDrag(); return; }
      const c = this.cursorProvider();
      const want = { x: c.x - offset.x, y: c.y - offset.y };
      const next = clampFeet(want, this.displayFor(c).workArea, this.size);
      const now = Date.now();
      const dt = Math.max(1, now - lastTime) / 1000;
      vx = vx * 0.6 + ((next.x - last.x) / dt) * 0.4;
      vy = vy * 0.6 + ((next.y - last.y) / dt) * 0.4;
      last = next;
      lastTime = now;
      if (next.x !== this.feet.x || next.y !== this.feet.y) this.applyFeet(next);
      const update: DragUpdate = { feet: next, vx, vy };
      this.pet.webContents.send(IPC.dragUpdate, update);
    }, 10);
  }

  stopDrag(): void {
    if (this.dragTimer) { clearInterval(this.dragTimer); this.dragTimer = null; }
    this.sendPlacement();
  }

  sendPlacement(): void {
    if (this.pet && !this.pet.isDestroyed()) this.pet.webContents.send(IPC.placement, this.getPlacement());
  }

  /** After a resolution / monitor change, pull her back onto a visible work area. */
  recorrectPosition(): void {
    if (!this.pet || this.pet.isDestroyed()) return;
    const wa = this.displayFor(this.feet).workArea;
    this.applyFeet(clampFeet(this.feet, wa, this.size));
    this.sendPlacement();
  }

  /**
   * Shows the user a spot on the primary display (fractions of its size, as the vision model saw the screenshot):
   * a ring on a click-through overlay, and the pet walks over to point at it.
   */
  pointAt(t: { nx: number; ny: number; label: string; note?: string }): void {
    const b = screen.getPrimaryDisplay().bounds;
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    const point = { x: Math.round(b.x + clamp(t.nx) * b.width), y: Math.round(b.y + clamp(t.ny) * b.height) };
    const label = t.label.slice(0, 40);
    this.showHighlight(b, { x: point.x - b.x, y: point.y - b.y, label, id: ++this.highlightId });
    this.sendToPet(IPC.petPoint, { point, label, note: (t.note ?? '').slice(0, 200) });
  }

  private showHighlight(bounds: Rect, ring: { x: number; y: number; label: string; id: number }): void {
    let win = this.highlight;
    const show = (w: BrowserWindow): void => {
      if (w.isDestroyed()) return;
      w.webContents.send(IPC.highlight, ring);
      w.showInactive();
      w.setAlwaysOnTop(true, ON_TOP_LEVEL);
    };
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        ...bounds, transparent: true, frame: false, resizable: false, movable: false, focusable: false,
        minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
        show: false, alwaysOnTop: true, backgroundColor: '#00000000', webPreferences: this.webPreferences(),
      });
      win.setIgnoreMouseEvents(true);                   // never in the way: every click goes to what is underneath
      win.on('closed', () => { this.highlight = null; });
      this.highlight = win;
      const created = win;
      created.webContents.once('did-finish-load', () => show(created));
      void created.loadURL(pageUrl('highlight'));
    } else {
      win.setBounds(bounds);
      show(win);
    }
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => { if (this.highlight && !this.highlight.isDestroyed()) this.highlight.hide(); }, HIGHLIGHT_MS);
  }

  /** Re-applies "stay on top" if the setting is on but the window lost it. */
  keepOnTop(): void {
    const pet = this.pet;
    if (!pet || pet.isDestroyed() || !pet.isVisible() || !this.config.getSettings().alwaysOnTop) return;
    if (!pet.isAlwaysOnTop()) pet.setAlwaysOnTop(true, ON_TOP_LEVEL);
  }

  applySettingsToWindows(): void {
    const s = this.config.getSettings();
    this.applyUiMode();
    if (!this.pet || this.pet.isDestroyed()) return;
    this.pet.setAlwaysOnTop(s.alwaysOnTop, ON_TOP_LEVEL);
    this.pet.setOpacity(s.opacity);
    this.recorrectPosition();        // also applies a new size, keeping her feet where they are
  }

  setPetVisible(visible: boolean): void {
    if (!this.pet || this.pet.isDestroyed()) return;
    if (visible) { this.pet.showInactive(); this.keepOnTop(); } else this.pet.hide();
    this.pet.webContents.send(IPC.visibility, visible);
  }

  private icon: Electron.NativeImage | null = null;
  /** Icon of the settings / chat windows (taskbar, Alt+Tab). */
  setIcon(icon: Electron.NativeImage): void {
    this.icon = icon;
    for (const w of [this.pet, this.main]) if (w && !w.isDestroyed()) w.setIcon(icon);
  }

  isDragging(): boolean { return !!this.dragTimer; }
  isPetVisible(): boolean { return !!this.pet && !this.pet.isDestroyed() && this.pet.isVisible(); }

  /**
   * The main window: chat, sessions, schedules, skills, profile and settings in one place. A normal
   * app window: resizable, maximizable, F11 full screen, remembers where it was. 'settings' opens the
   * same window on its settings page.
   */
  openPanel(view: PanelView, page?: string): void {
    const target = view === 'settings' ? 'settings' : page;
    const existing = this.main;
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show(); existing.focus();
      if (target) existing.webContents.send(IPC.navigate, target);
      return;
    }
    const wa = this.displayFor(this.feet).workArea;
    const saved = this.config.getMainWindow();
    const fits = !!saved && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x + 80 < a.x + a.width && saved.x + saved.width - 80 > a.x && saved.y >= a.y - 10 && saved.y + 40 < a.y + a.height;
    });
    const width = Math.min(saved?.width ?? 1080, wa.width - 20);
    const height = Math.min(saved?.height ?? 720, wa.height - 20);
    const bounds = fits && saved
      ? { x: saved.x, y: saved.y, width, height }
      : { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
    const dark = this.isDark();
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 760, minHeight: 520,
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarColors(dark),
      resizable: true, maximizable: true, fullscreenable: true,
      alwaysOnTop: this.chatPinned,
      backgroundColor: dark ? DARK_BG : LIGHT_BG,
      title: this.config.getSettings().petName || '桌宠',
      ...(this.icon ? { icon: this.icon } : {}),
      autoHideMenuBar: true,
      show: false,
      webPreferences: this.webPreferences(),
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => { if (saved?.maximized && fits) win.maximize(); win.show(); });
    if (this.chatPinned) win.setAlwaysOnTop(true, ON_TOP_LEVEL);
    // Closing only hides it: a running task, its confirmations and the conversation stay alive.
    win.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      if (win.isFullScreen()) win.setFullScreen(false);
      win.hide();
    });
    win.on('closed', () => { if (this.main === win) this.main = null; });
    const remember = (): void => {
      if (this.boundsTimer) clearTimeout(this.boundsTimer);
      this.boundsTimer = setTimeout(() => {
        if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
        const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
        this.config.setMainWindow({ ...b, maximized: win.isMaximized() });
      }, 500);
    };
    win.on('resize', remember); win.on('move', remember); win.on('maximize', remember); win.on('unmaximize', remember);
    const tellState = (): void => { if (!win.isDestroyed()) win.webContents.send(IPC.panelState, this.panelState(win)); };
    win.on('maximize', tellState); win.on('unmaximize', tellState);
    win.on('enter-full-screen', tellState); win.on('leave-full-screen', tellState);
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    });
    void win.loadURL(target ? `${pageUrl('chat')}:${target}` : pageUrl('chat'));
    this.main = win;
  }

  private main: BrowserWindow | null = null;
  /** The main window, if it exists (the browser pane lives in it). */
  mainWindow(): BrowserWindow | null { return this.main && !this.main.isDestroyed() ? this.main : null; }
  private boundsTimer: NodeJS.Timeout | null = null;
  private quitting = false;
  /** Called when the app quits: the main window may really close now. */
  allowClose(): void { this.quitting = true; }

  private isDark(): boolean {
    const mode = this.config.getSettings().uiMode;
    return mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors);
  }

  /** Light / dark: Electron's theme source makes every page's prefers-color-scheme follow the setting. */
  applyUiMode(): void {
    const mode = this.config.getSettings().uiMode;
    if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
    const win = this.main;
    if (!win || win.isDestroyed()) return;
    const dark = this.isDark();
    try { win.setTitleBarOverlay(titleBarColors(dark)); } catch { /* not supported here */ }
    win.setBackgroundColor(dark ? DARK_BG : LIGHT_BG);
  }

  private panelState(win: BrowserWindow): PanelState {
    return { pinned: this.chatPinned, fullscreen: win.isFullScreen(), maximized: win.isMaximized() };
  }

  /** Main window: only hides (the conversation and a running task stay alive). */
  closePanelOf(webContentsId: number): void {
    const win = this.main;
    if (!win || win.isDestroyed() || win.webContents.id !== webContentsId) return;
    if (win.isFullScreen()) win.setFullScreen(false);
    win.hide();
  }

  /** Shows the main window without stealing focus (e.g. when a task needs confirmation); opens it if needed. */
  revealChat(): void {
    const win = this.main;
    if (!win || win.isDestroyed()) { this.openPanel('chat'); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
  }

  chatControl(webContentsId: number, action: string): PanelState {
    const win = this.main;
    if (!win || win.isDestroyed() || win.webContents.id !== webContentsId) return { pinned: this.chatPinned, fullscreen: false, maximized: false };
    if (action === 'toggle-pin') {
      this.chatPinned = !this.chatPinned;
      win.setAlwaysOnTop(this.chatPinned, ON_TOP_LEVEL);
    } else if (action === 'toggle-fullscreen') {
      win.setFullScreen(!win.isFullScreen());
    } else if (action === 'hide') {
      this.closePanelOf(webContentsId);
    }
    return this.panelState(win);
  }

  /** Every window that is allowed to talk to main over IPC. */
  allWebContentsIds(): number[] {
    const ids: number[] = [];
    if (this.pet && !this.pet.isDestroyed()) ids.push(this.pet.webContents.id);
    if (this.main && !this.main.isDestroyed()) ids.push(this.main.webContents.id);
    return ids;
  }

  broadcast(channel: string, payload: unknown): void {
    if (this.pet && !this.pet.isDestroyed()) this.pet.webContents.send(channel, payload);
    if (this.main && !this.main.isDestroyed()) this.main.webContents.send(channel, payload);
  }

  sendToPet(channel: string, payload: unknown): void {
    if (this.pet && !this.pet.isDestroyed()) this.pet.webContents.send(channel, payload);
  }
}

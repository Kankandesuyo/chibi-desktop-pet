import { BrowserWindow, screen, type Display } from 'electron';
import * as path from 'node:path';
import {
  CHARACTER_HALF_WIDTH, CHARACTER_HEIGHT, FOOT_MARGIN, IPC, windowSizeFor,
} from '../shared/constants';
import type { DragUpdate, PetPlacement, Point, Rect } from '../shared/types';
import type { ConfigStore } from './configStore';

export type PanelView = 'chat' | 'settings';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
export const APP_ORIGIN = 'app://local';

function pageUrl(view: 'pet' | PanelView): string {
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
  private panels = new Map<PanelView, BrowserWindow>();
  /** Chat window: stays on top unless unpinned; four sizes. */
  private chatPinned = false;
  private chatSize = 1;
  static readonly CHAT_SIZES = [{ width: 340, height: 460 }, { width: 400, height: 580 }, { width: 520, height: 720 }, { width: 660, height: 880 }];
  private feet: Point = { x: 0, y: 0 };
  private dragTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigStore) {}

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
    if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
    win.setOpacity(settings.opacity);
    // Start click-through; the renderer turns capturing on only while the cursor is over the character.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => { this.pet = null; this.stopDrag(); });
    void win.loadURL(pageUrl('pet'));
    this.pet = win;

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

  applySettingsToWindows(): void {
    const s = this.config.getSettings();
    if (!this.pet || this.pet.isDestroyed()) return;
    this.pet.setAlwaysOnTop(s.alwaysOnTop, 'floating');
    this.pet.setOpacity(s.opacity);
    this.recorrectPosition();        // also applies a new size, keeping her feet where they are
  }

  setPetVisible(visible: boolean): void {
    if (!this.pet || this.pet.isDestroyed()) return;
    if (visible) this.pet.showInactive(); else this.pet.hide();
    this.pet.webContents.send(IPC.visibility, visible);
  }

  private icon: Electron.NativeImage | null = null;
  /** Icon of the settings / chat windows (taskbar, Alt+Tab). */
  setIcon(icon: Electron.NativeImage): void {
    this.icon = icon;
    for (const w of [this.pet, ...this.panels.values()]) if (w && !w.isDestroyed()) w.setIcon(icon);
  }

  isDragging(): boolean { return !!this.dragTimer; }
  isPetVisible(): boolean { return !!this.pet && !this.pet.isDestroyed() && this.pet.isVisible(); }

  openPanel(view: PanelView): void {
    const existing = this.panels.get(view);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const size = view === 'chat' ? this.fitToScreen(WindowManager.CHAT_SIZES[this.chatSize] ?? { width: 400, height: 580 }) : { width: 460, height: 720 };
    const wa = this.displayFor(this.feet).workArea;
    const petTop = this.feet.y - CHARACTER_HEIGHT * this.size;
    let x = this.feet.x - CHARACTER_HALF_WIDTH * this.size - size.width - 8;
    if (x < wa.x) x = this.feet.x + CHARACTER_HALF_WIDTH * this.size + 8;
    x = Math.min(wa.x + wa.width - size.width, Math.max(wa.x, x));
    const y = Math.min(wa.y + wa.height - size.height, Math.max(wa.y, petTop - size.height / 2));
    const win = new BrowserWindow({
      ...size,
      x: Math.round(x),
      y: Math.round(y),
      frame: view === 'settings',
      transparent: view === 'chat',
      resizable: true,
      minWidth: view === 'chat' ? 300 : 380,
      minHeight: view === 'chat' ? 360 : 400,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: view === 'chat',
      alwaysOnTop: view === 'chat' && this.chatPinned,
      hasShadow: view === 'settings',
      backgroundColor: view === 'chat' ? '#00000000' : '#fff8f0',
      title: view === 'chat' ? '聊天' : '桌宠设置',
      ...(this.icon ? { icon: this.icon } : {}),
      autoHideMenuBar: true,
      show: false,
      webPreferences: this.webPreferences(),
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => win.show());
    if (view === 'chat' && this.chatPinned) win.setAlwaysOnTop(true, 'floating');
    win.on('closed', () => this.panels.delete(view));
    void win.loadURL(pageUrl(view));
    this.panels.set(view, win);
  }

  closePanelOf(webContentsId: number): void {
    for (const [view, win] of this.panels) {
      if (win.isDestroyed() || win.webContents.id !== webContentsId) continue;
      // Chat only hides: a running task, its confirmations and the conversation stay alive.
      if (view === 'chat') win.hide(); else win.close();
    }
  }

  private fitToScreen(size: { width: number; height: number }): { width: number; height: number } {
    const wa = this.displayFor(this.feet).workArea;
    return { width: Math.min(size.width, wa.width - 20), height: Math.min(size.height, wa.height - 20) };
  }

  /** Re-shows the chat if it was hidden, without stealing focus (e.g. when a task needs confirmation). */
  revealChat(): void {
    const win = this.panels.get('chat');
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  }

  chatControl(webContentsId: number, action: string): { pinned: boolean; sizeIndex: number; sizeCount: number } {
    const win = this.panels.get('chat');
    const state = () => ({ pinned: this.chatPinned, sizeIndex: this.chatSize, sizeCount: WindowManager.CHAT_SIZES.length });
    if (!win || win.isDestroyed() || win.webContents.id !== webContentsId) return state();
    if (action === 'toggle-pin') {
      this.chatPinned = !this.chatPinned;
      win.setAlwaysOnTop(this.chatPinned, 'floating');
    } else if (action === 'bigger' || action === 'smaller') {
      this.chatSize = Math.max(0, Math.min(WindowManager.CHAT_SIZES.length - 1, this.chatSize + (action === 'bigger' ? 1 : -1)));
      const next = this.fitToScreen(WindowManager.CHAT_SIZES[this.chatSize] as { width: number; height: number });
      const b = win.getBounds();
      const wa = this.displayFor({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
      // grow/shrink around the bottom-right corner area but keep the window on screen
      let x = b.x + b.width - next.width; let y = b.y + b.height - next.height;
      x = Math.min(wa.x + wa.width - next.width, Math.max(wa.x, x));
      y = Math.min(wa.y + wa.height - next.height, Math.max(wa.y, y));
      win.setBounds({ x: Math.round(x), y: Math.round(y), ...next }, true);
    } else if (action === 'hide') {
      win.hide();
    }
    return state();
  }

  /** Free resize from the chat's corner grip; keeps the top-left corner, stays on screen, respects minimum size. */
  chatResize(webContentsId: number, width: number, height: number): void {
    const win = this.panels.get('chat');
    if (!win || win.isDestroyed() || win.webContents.id !== webContentsId) return;
    const b = win.getBounds();
    const wa = this.displayFor({ x: b.x + 10, y: b.y + 10 }).workArea;
    const w = Math.round(Math.max(300, Math.min(width, wa.x + wa.width - b.x)));
    const h = Math.round(Math.max(360, Math.min(height, wa.y + wa.height - b.y)));
    if (w !== b.width || h !== b.height) win.setBounds({ x: b.x, y: b.y, width: w, height: h });
  }

  /** Every window that is allowed to talk to main over IPC. */
  allWebContentsIds(): number[] {
    const ids: number[] = [];
    if (this.pet && !this.pet.isDestroyed()) ids.push(this.pet.webContents.id);
    for (const w of this.panels.values()) if (!w.isDestroyed()) ids.push(w.webContents.id);
    return ids;
  }

  broadcast(channel: string, payload: unknown): void {
    if (this.pet && !this.pet.isDestroyed()) this.pet.webContents.send(channel, payload);
    for (const w of this.panels.values()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }

  sendToPet(channel: string, payload: unknown): void {
    if (this.pet && !this.pet.isDestroyed()) this.pet.webContents.send(channel, payload);
  }
}

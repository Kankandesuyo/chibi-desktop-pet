import { TUNING } from '../config/petConfig';

export interface InteractionHost {
  hitTest(clientX: number, clientY: number): { hit: boolean; head: boolean };
  canDrag(): boolean;
  setIgnoreMouse(ignore: boolean): void;
  onGrab(clientX: number, clientY: number): boolean;
  onRelease(): void;
  onClick(part: 'head' | 'body'): void;
  onDoubleClick(): void;
  onPet(direction: number): void;
  onHover(clientX: number | null, clientY: number | null): void;
  onContextMenu(): void;
}

/**
 * Raw DOM mouse events -> pet-level intents (grab, click, double-click, pet, hover).
 * It never touches sprites or animation; everything goes through InteractionHost.
 *
 * It also drives click-through: the window ignores the mouse unless the cursor is on an opaque
 * pixel of the character (or a drag is in progress).
 */
export class InteractionController {
  private ignoring = true;
  private pressed: { x: number; y: number; part: 'head' | 'body'; holdTimer: number } | null = null;
  private dragging = false;
  private clickTimer: number | null = null;
  private petTrail: { t: number; d: number }[] = [];
  private lastMove: { x: number; t: number } | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly el: HTMLElement, private readonly host: InteractionHost) {
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void): void => {
      target.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on(window, 'mousemove', (e) => this.onMouseMove(e));
    on(window, 'mouseleave', () => this.onLeave());
    on(document.documentElement, 'mouseleave', () => this.onLeave());
    on(el, 'pointerdown', (e) => this.onPointerDown(e));
    on(el, 'pointerup', (e) => this.onPointerUp(e));
    on(el, 'pointercancel', (e) => this.onPointerUp(e));
    on(el, 'contextmenu', (e) => { e.preventDefault(); if (this.host.hitTest(e.clientX, e.clientY).hit) this.host.onContextMenu(); });
  }

  private setIgnore(ignore: boolean): void {
    if (ignore === this.ignoring) return;
    this.ignoring = ignore;
    this.host.setIgnoreMouse(ignore);
  }

  private onLeave(): void {
    if (this.dragging || this.pressed) return;
    this.setIgnore(true);
    this.host.onHover(null, null);
    this.lastMove = null;
    this.petTrail = [];
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.dragging) return;                       // the main process is following the cursor
    const { hit, head } = this.host.hitTest(e.clientX, e.clientY);
    if (this.pressed) {
      const moved = Math.abs(e.clientX - this.pressed.x) + Math.abs(e.clientY - this.pressed.y);
      if (moved > TUNING.dragMovePx) this.beginDrag(e.clientX, e.clientY);
      return;
    }
    this.setIgnore(!hit);
    this.host.onHover(hit ? e.clientX : null, hit ? e.clientY : null);

    // Petting = the pointer sliding back and forth over her head with no button held.
    const now = performance.now();
    if (head && e.buttons === 0) {
      if (this.lastMove) {
        const dx = e.clientX - this.lastMove.x;
        const dtMs = Math.max(1, now - this.lastMove.t);
        if (Math.abs(dx) / dtMs < 2.5) this.petTrail.push({ t: now, d: Math.abs(dx) });   // ignore fly-bys
        this.petTrail = this.petTrail.filter((p) => now - p.t < TUNING.petWindowMs);
        const total = this.petTrail.reduce((s, p) => s + p.d, 0);
        if (total > TUNING.petDistance) {
          this.petTrail = this.petTrail.slice(-3);
          this.host.onPet(Math.sign(dx));
        }
      }
      this.lastMove = { x: e.clientX, t: now };
    } else {
      this.lastMove = null;
      this.petTrail = [];
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const { hit, head } = this.host.hitTest(e.clientX, e.clientY);
    if (!hit) return;
    this.el.setPointerCapture(e.pointerId);
    this.setIgnore(false);
    const x = e.clientX, y = e.clientY;
    const holdTimer = window.setTimeout(() => this.beginDrag(x, y), TUNING.dragHoldMs);
    this.pressed = { x, y, part: head ? 'head' : 'body', holdTimer };
  }

  private beginDrag(x: number, y: number): void {
    if (!this.pressed || this.dragging) return;
    window.clearTimeout(this.pressed.holdTimer);
    if (!this.host.canDrag() || !this.host.onGrab(x, y)) return;   // stays a click
    this.dragging = true;
    if (this.clickTimer !== null) { window.clearTimeout(this.clickTimer); this.clickTimer = null; }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 0 && e.type !== 'pointercancel') return;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    const pressed = this.pressed;
    this.pressed = null;
    if (pressed) window.clearTimeout(pressed.holdTimer);
    if (this.dragging) {
      this.dragging = false;
      this.host.onRelease();
      return;
    }
    if (!pressed || e.type === 'pointercancel') return;
    if (this.clickTimer !== null) {
      // Second click inside the window -> double click.
      window.clearTimeout(this.clickTimer);
      this.clickTimer = null;
      this.host.onDoubleClick();
    } else {
      this.clickTimer = window.setTimeout(() => {
        this.clickTimer = null;
        this.host.onClick(pressed.part);
      }, TUNING.doubleClickMs);
    }
  }

  /** Force-release (e.g. the window was hidden mid-drag). */
  cancel(): void {
    if (this.pressed) window.clearTimeout(this.pressed.holdTimer);
    this.pressed = null;
    if (this.dragging) { this.dragging = false; this.host.onRelease(); }
  }

  destroy(): void {
    this.cancel();
    if (this.clickTimer !== null) window.clearTimeout(this.clickTimer);
    for (const fn of this.cleanup) fn();
    this.cleanup.length = 0;
  }
}

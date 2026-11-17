import { TUNING } from '../config/petConfig';

/**
 * Independent blink timer: open → closed → open, a few seconds apart, sometimes twice in a row.
 * It only reports "eyes closed right now?"; the animation layer swaps in the aligned blink frame,
 * which is pixel-identical to the idle frame outside the eyes, so nothing else can shift.
 */
export class BlinkController {
  private untilNext: number;
  private closedFor = 0;
  private pendingDouble = false;

  constructor(private readonly rng: () => number = Math.random) {
    this.untilNext = 1.5 + rng() * 2;
  }

  get closed(): boolean { return this.closedFor > 0; }

  update(dt: number, allowed: boolean): boolean {
    if (this.closedFor > 0) {
      this.closedFor -= dt;
      if (this.closedFor <= 0) {
        this.closedFor = 0;
        if (this.pendingDouble) { this.pendingDouble = false; this.untilNext = 0.16; }
        else this.untilNext = 2.4 + this.rng() * 3.6;
      }
      return this.closed;
    }
    if (!allowed) { this.untilNext = Math.max(this.untilNext, 0.6); return false; }
    this.untilNext -= dt;
    if (this.untilNext <= 0) {
      this.closedFor = TUNING.blinkMs / 1000;
      this.pendingDouble = this.rng() < 0.18;
    }
    return this.closed;
  }
}

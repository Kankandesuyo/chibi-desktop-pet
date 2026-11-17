import type { DragUpdate } from '../../shared/types';

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const DEG = Math.PI / 180;

/** What she is doing while she hangs from the hand (between struggles). */
export type HoldAct = 'dangle' | 'kick' | 'peek' | 'limp';
/** Things the engine reacts to (pose, speech bubble, effects). */
export type DragEvent = 'struggle' | 'calm' | 'act' | 'dizzy' | 'whee' | 'tired';

export interface DragTuning {
  /** Seconds held before the first struggle (rolled ±30 %). */
  struggleAfter: number;
}

/**
 * Physics and "acting" of being held. The window follows the cursor exactly (main process); here the
 * body behaves like a soft pendulum under the hand:
 *   - swing:   under-damped pendulum, pushed back by the hand's sideways speed, so she keeps swinging
 *              a few times after the hand stops instead of freezing;
 *   - tail:    a second, slower pendulum (legs, skirt, hair ends) that trails the body;
 *   - stretch: a bouncy spring along the body — pulled up fast she stretches, dropped she bunches up.
 * On top of that she never repeats one loop: struggles come at random intervals as uneven bursts,
 * in between she dangles, kicks, looks around, and she gets tired and dizzy.
 */
export class DragController {
  active = false;
  /** Seconds held in this grab. */
  heldFor = 0;
  /** Pendulum angle in radians (positive = clockwise). */
  swing = 0;
  private swingVel = 0;
  /** Angle of the trailing lower body (radians). */
  tail = 0;
  private tailVel = 0;
  /** Extra length along the body: +0.1 = 10 % longer. */
  stretch = 0;
  private stretchVel = 0;
  /** Body offset behind the cursor, in px. */
  lagX = 0;
  lagY = 0;
  vx = 0;
  vy = 0;

  act: HoldAct = 'dangle';
  struggling = false;
  /** Struggle shake: extra angle (radians) and sideways jitter (px at size 1). */
  wiggle = 0;
  wiggleX = 0;
  /** 0…1 how hard the legs are kicking right now. */
  kick = 0;
  /** 0…1, grows the longer she is held; a tired pet struggles less and hangs limp. */
  tired = 0;

  private actLeft = 0;
  private struggleFor = 0;
  private struggleLen = 0;
  private nextStruggle = 0;
  private f1 = 22;
  private f2 = 7;
  private phase = 0;
  private lastDir = 0;
  private reversals: number[] = [];
  private fastFor = 0;
  private dizzyCooldown = 0;
  private wheeCooldown = 0;
  private saidTired = false;
  private events: DragEvent[] = [];

  constructor(private readonly tuning: DragTuning = { struggleAfter: 2.6 }, private readonly rng: () => number = Math.random) {}

  private roll(min: number, max: number): number { return min + (max - min) * this.rng(); }

  begin(): void {
    this.active = true;
    this.heldFor = 0;
    this.vx = 0;
    this.vy = 0;
    // Picked up: a little bounce and a random nudge, so no two grabs start the same.
    this.stretchVel = 1.5;
    this.swingVel = this.roll(-1.6, 1.6);
    this.act = 'dangle';
    this.actLeft = this.roll(1.2, 2.4);
    this.struggling = false;
    this.nextStruggle = this.tuning.struggleAfter * this.roll(0.7, 1.3);
    this.tired = 0;
    this.saidTired = false;
    this.lastDir = 0;
    this.reversals = [];
    this.fastFor = 0;
    this.dizzyCooldown = 0;
    this.wheeCooldown = 1.5;
    this.events = [];
  }

  onUpdate(u: DragUpdate): void {
    if (!this.active) return;
    this.vx = u.vx;
    this.vy = u.vy;
  }

  /** Ends the grab and returns the sideways speed to carry into the fall. */
  end(): number {
    this.active = false;
    this.struggling = false;
    this.events = [];
    return this.vx;
  }

  /** Events since the last call, oldest first. */
  takeEvents(): DragEvent[] {
    if (this.events.length === 0) return this.events;
    const out = this.events;
    this.events = [];
    return out;
  }

  update(dt: number): void {
    if (this.active) {
      this.heldFor += dt;
      this.tired = clamp((this.heldFor - 10) / 14, 0, 1);
      this.physics(dt, -clamp(this.vx, -1800, 1800) * 0.00022, clamp(-this.vy * 0.00009, -0.07, 0.12), 46, 3 + this.tired * 1.6);
      const k = Math.min(1, dt * 10);
      this.lagX += (clamp(-this.vx * 0.022, -16, 16) - this.lagX) * k;
      this.lagY += (clamp(-this.vy * 0.022, -12, 16) - this.lagY) * k;
      this.senses(dt);
      this.acting(dt);
    } else {
      // Released: the same spring carries on and settles, instead of snapping upright.
      this.physics(dt, 0, 0, 70, 9);
      const k = Math.min(1, dt * 9);
      this.lagX += (0 - this.lagX) * k;
      this.lagY += (0 - this.lagY) * k;
      this.wiggle += (0 - this.wiggle) * k;
      this.wiggleX += (0 - this.wiggleX) * k;
      this.kick += (0 - this.kick) * k;
      this.vx = 0;
      this.vy = 0;
    }
  }

  private physics(dt: number, swingRest: number, stretchRest: number, stiffness: number, damping: number): void {
    let acc = -stiffness * (this.swing - swingRest) - damping * this.swingVel;
    const over = Math.abs(this.swing) - 0.9;                     // soft end stop instead of a hard clamp
    if (over > 0) acc -= Math.sign(this.swing) * over * 400;
    this.swingVel += acc * dt;
    this.swing = clamp(this.swing + this.swingVel * dt, -1.15, 1.15);

    this.tailVel += (-30 * (this.tail - this.swing) - 4.2 * this.tailVel) * dt;
    this.tail = clamp(this.tail + this.tailVel * dt, -1.6, 1.6);

    // Swinging hard also pulls her outward a little (centrifugal).
    const rest = stretchRest + Math.min(0.05, this.swingVel * this.swingVel * 0.004);
    this.stretchVel += (-220 * (this.stretch - rest) - 11 * this.stretchVel) * dt;
    this.stretch = clamp(this.stretch + this.stretchVel * dt, -0.12, 0.2);
  }

  /** Notices being shaken back and forth, or whisked across the screen. */
  private senses(dt: number): void {
    this.dizzyCooldown -= dt;
    this.wheeCooldown -= dt;
    const dir = Math.abs(this.vx) > 450 ? Math.sign(this.vx) : 0;
    if (dir !== 0) {
      if (this.lastDir !== 0 && dir !== this.lastDir) this.reversals.push(this.heldFor);
      this.lastDir = dir;
    }
    this.reversals = this.reversals.filter((t) => this.heldFor - t < 1.5);
    if (this.reversals.length >= 5 && this.dizzyCooldown <= 0) {
      this.reversals = [];
      this.dizzyCooldown = 5;
      this.endStruggle();
      this.act = 'limp';
      this.actLeft = 2.6;
      this.nextStruggle = Math.max(this.nextStruggle, 3.2);
      this.events.push('dizzy');
      return;
    }
    const speed = Math.hypot(this.vx, this.vy);
    this.fastFor = speed > 1500 ? this.fastFor + dt : 0;
    if (this.fastFor > 0.25 && this.wheeCooldown <= 0) {
      this.wheeCooldown = 6;
      this.fastFor = 0;
      this.events.push('whee');
    }
  }

  private endStruggle(): void {
    if (!this.struggling) return;
    this.struggling = false;
    this.nextStruggle = this.roll(2.8, 6.5) * (1 + this.tired * 1.5);
    this.events.push('calm');
  }

  private acting(dt: number): void {
    if (this.tired > 0.6 && !this.saidTired) { this.saidTired = true; this.events.push('tired'); }

    if (this.struggling) {
      this.struggleFor += dt;
      const p = this.struggleFor / this.struggleLen;
      if (p >= 1) {
        this.endStruggle();
      } else {
        // Uneven bursts: a fast shake whose strength comes and goes, fading in and out at the ends.
        this.phase += dt * this.f1;
        const burst = 0.35 + 0.65 * Math.pow(Math.abs(Math.sin(this.struggleFor * this.f2)), 1.5);
        const env = Math.sin(Math.PI * p) ** 0.6 * burst;
        const amp = (7.5 - 3.5 * this.tired) * DEG;
        this.wiggle = Math.sin(this.phase) * env * amp;
        this.wiggleX = Math.sin(this.phase * 1.31 + 1) * env * 2.6;
      }
    } else {
      const k = Math.min(1, dt * 12);
      this.wiggle += (0 - this.wiggle) * k;
      this.wiggleX += (0 - this.wiggleX) * k;
      this.nextStruggle -= dt;
      this.actLeft -= dt;
      if (this.nextStruggle <= 0) {
        this.struggling = true;
        this.struggleFor = 0;
        this.struggleLen = this.roll(1.0, 2.3) * (1 - 0.4 * this.tired);
        this.f1 = this.roll(17, 27);
        this.f2 = this.roll(4.5, 9);
        this.phase = this.roll(0, 6.28);
        this.swingVel += this.roll(-1.2, 1.2);                  // she throws her weight around
        this.events.push('struggle');
      } else if (this.actLeft <= 0) {
        this.nextAct();
      }
    }

    const kickTarget = this.struggling ? 0.85 : this.act === 'kick' ? 1 : 0;
    this.kick += (kickTarget - this.kick) * Math.min(1, dt * 7);
  }

  private nextAct(): void {
    const r = this.rng();
    let next: HoldAct;
    if (this.tired > 0.6) next = r < 0.75 ? 'limp' : 'dangle';
    else if (this.act === 'dangle') next = r < 0.5 ? 'kick' : r < 0.9 ? 'peek' : 'dangle';
    else next = r < 0.65 ? 'dangle' : this.act === 'kick' ? 'peek' : 'kick';
    this.act = next;
    this.actLeft = next === 'kick' ? this.roll(0.8, 1.5) : next === 'peek' ? this.roll(1.3, 2.2) : next === 'limp' ? this.roll(3, 5) : this.roll(1.4, 3.2);
    if (next === 'kick') this.swingVel += this.roll(-0.9, 0.9);
    this.events.push('act');
  }
}

import type { PetState } from '../../shared/types';
import { TUNING } from '../config/petConfig';

export type AutoAction = PetState | 'sway' | 'hop';

export interface SchedulerContext {
  state: PetState;
  autoMove: boolean;
  /** 0–1 from the settings. */
  frequency: number;
  sleepy: boolean;
  idleFor: number;
  angry: boolean;
  nightTime: boolean;
  /** Extra scenes this character has art for (e.g. 'eating'); each is as likely as looking around. */
  scenes?: readonly PetState[];
}

/**
 * Decides what she does on her own. Only ever speaks up while she is idle, and never more often than
 * TUNING.minAutoGap — so random behaviour can neither interrupt anything nor fire every frame.
 */
export class BehaviorScheduler {
  private wait: number;

  constructor(private readonly rng: () => number = Math.random) {
    this.wait = 2 + rng() * 2;
  }

  private rollWait(frequency: number): number {
    const f = Math.min(1, Math.max(0, frequency));
    const base = 14 - 10 * f;                       // 14 s (rare) … 4 s (lively)
    return Math.max(TUNING.minAutoGap, base * (0.6 + 0.8 * this.rng()));
  }

  update(dt: number, ctx: SchedulerContext): AutoAction | null {
    if (ctx.state !== 'idle') return null;
    this.wait -= dt;
    if (this.wait > 0) return null;
    this.wait = this.rollWait(ctx.frequency);

    if (ctx.sleepy || ctx.idleFor > TUNING.sleepAfterIdle * (ctx.nightTime ? 0.5 : 1)) return 'sleeping';
    if (ctx.angry) return 'sway';

    const table: [AutoAction, number][] = [['lookAround', 2], ['sway', 2], ['hop', 1]];
    for (const scene of ctx.scenes ?? []) table.push([scene, 3]);
    // Walking (either way) and running are equally likely.
    if (ctx.autoMove) table.push(['turnLeft', 2], ['turnRight', 2], ['run', 4]);
    const total = table.reduce((s, [, w]) => s + w, 0);
    let roll = this.rng() * total;
    for (const [action, weight] of table) {
      roll -= weight;
      if (roll <= 0) return action;
    }
    return 'lookAround';
  }
}

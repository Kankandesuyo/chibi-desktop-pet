import type { PetState } from '../../shared/types';

/** Higher number wins: drag > fall/land > user interaction > talking > autonomous > idle. */
export const PRIORITY = { idle: 0, auto: 1, talk: 2, interact: 3, physics: 4, drag: 5 } as const;

interface StateSpec {
  priority: number;
  /** Seconds; a [min, max] range is rolled on entry; null = stays until something else ends it. */
  duration: number | readonly [number, number] | null;
  /** Where to go when the duration runs out. */
  next: PetState;
}

export const STATE_SPECS: Record<PetState, StateSpec> = {
  idle: { priority: PRIORITY.idle, duration: null, next: 'idle' },
  blink: { priority: PRIORITY.interact, duration: 0.9, next: 'idle' },
  lookAround: { priority: PRIORITY.auto, duration: 2.4, next: 'idle' },
  walkLeft: { priority: PRIORITY.auto, duration: [2.5, 6], next: 'idle' },
  walkRight: { priority: PRIORITY.auto, duration: [2.5, 6], next: 'idle' },
  run: { priority: PRIORITY.auto, duration: [1.2, 2.2], next: 'idle' },
  turnLeft: { priority: PRIORITY.auto, duration: 0.26, next: 'walkLeft' },
  turnRight: { priority: PRIORITY.auto, duration: 0.26, next: 'walkRight' },
  jump: { priority: PRIORITY.interact, duration: 0.7, next: 'idle' },
  dragStart: { priority: PRIORITY.drag, duration: 0.24, next: 'dragging' },
  dragging: { priority: PRIORITY.drag, duration: null, next: 'dragging' },
  struggling: { priority: PRIORITY.drag, duration: 6, next: 'dragging' },   // normally ended earlier by the drag controller; the timer is only a safety net
  falling: { priority: PRIORITY.physics, duration: null, next: 'landing' },
  landing: { priority: PRIORITY.physics, duration: 0.45, next: 'idle' },
  petting: { priority: PRIORITY.interact, duration: 1.1, next: 'idle' },
  happy: { priority: PRIORITY.interact, duration: 1.7, next: 'idle' },
  shy: { priority: PRIORITY.interact, duration: 1.9, next: 'idle' },
  angry: { priority: PRIORITY.interact, duration: 3.2, next: 'idle' },
  sleeping: { priority: PRIORITY.auto, duration: [25, 70], next: 'waking' },
  waking: { priority: PRIORITY.interact, duration: 0.9, next: 'idle' },
  talking: { priority: PRIORITY.talk, duration: 30, next: 'idle' },
};

const DRAG_GROUP: readonly PetState[] = ['dragStart', 'dragging', 'struggling'];
/** States that may be re-requested while active to restart their timer. */
const REFRESHABLE: readonly PetState[] = ['petting', 'talking'];

export type TransitionListener = (next: PetState, prev: PetState) => void;

/**
 * One state at a time. `request` is what input / AI / the scheduler call — it may be refused.
 * `force` is for the controllers that own a state (drag, physics) and for timers.
 */
export class PetStateMachine {
  private current: PetState = 'idle';
  private elapsed = 0;
  private limit: number | null = null;
  private listeners = new Set<TransitionListener>();

  constructor(private readonly rng: () => number = Math.random) {}

  get state(): PetState { return this.current; }
  /** Seconds spent in the current state. */
  get time(): number { return this.elapsed; }
  /** 0–1 progress through a timed state (0 for untimed ones). */
  get progress(): number { return this.limit ? Math.min(1, this.elapsed / this.limit) : 0; }

  onTransition(fn: TransitionListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  is(...states: PetState[]): boolean { return states.includes(this.current); }
  isDragging(): boolean { return DRAG_GROUP.includes(this.current); }

  canEnter(next: PetState): boolean {
    const cur = this.current;
    if (next === cur) return REFRESHABLE.includes(next);
    // While being held, only the drag controller decides what happens next.
    if (DRAG_GROUP.includes(cur)) return DRAG_GROUP.includes(next);
    // In the air: she can be caught again, nothing else.
    if (cur === 'falling') return next === 'dragStart';
    // Asleep: she can be woken or picked up, but never starts unrelated actions.
    if (cur === 'sleeping') return next === 'waking' || next === 'dragStart';
    return STATE_SPECS[next].priority >= STATE_SPECS[cur].priority;
  }

  /** Ask for a state. Returns false (and changes nothing) when the current state outranks it. */
  request(next: PetState): boolean {
    if (!this.canEnter(next)) return false;
    this.enter(next);
    return true;
  }

  /** Unconditional transition, for the owner of the current state and for timers. */
  force(next: PetState): void { this.enter(next); }

  private enter(next: PetState): void {
    const prev = this.current;
    const d = STATE_SPECS[next].duration;
    this.current = next;
    this.elapsed = 0;
    this.limit = d === null ? null : typeof d === 'number' ? d : d[0] + (d[1] - d[0]) * this.rng();
    if (prev !== next) for (const fn of this.listeners) fn(next, prev);
  }

  /** Shorten or extend the running timer (e.g. petting continues while the hand keeps moving). */
  extend(seconds: number): void {
    if (this.limit !== null) this.limit = Math.max(this.limit, this.elapsed + seconds);
  }

  update(dt: number): void {
    this.elapsed += dt;
    if (this.limit !== null && this.elapsed >= this.limit) this.enter(STATE_SPECS[this.current].next);
  }
}

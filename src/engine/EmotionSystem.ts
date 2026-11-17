import type { Emotion, PetState, PetStats } from '../../shared/types';
import { TUNING } from '../config/petConfig';

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** Mood, affection, energy. It only *suggests* reactions; the state machine still decides. */
export class EmotionSystem {
  stats: PetStats;
  /** How many times she was grabbed recently (0–3). Cools down by itself. */
  annoyance = 0;
  /** Seconds since the user last did anything to her. */
  idleFor = 0;
  private moodTimer = 0;
  private cooldown = 0;
  private dirty = false;

  constructor(initial: PetStats, private readonly onChange: (stats: PetStats) => void = () => undefined) {
    this.stats = { ...initial };
  }

  private touch(): void { this.dirty = true; }

  setMood(mood: Emotion, holdSeconds = 12): void {
    if (this.stats.mood !== mood) { this.stats.mood = mood; this.touch(); }
    this.moodTimer = holdSeconds;
  }

  private interacted(): void {
    this.idleFor = 0;
    this.stats.interactionCount += 1;
    this.touch();
  }

  onClick(): void { this.interacted(); }

  onPet(): void {
    this.interacted();
    this.stats.affection = clamp(this.stats.affection + 1.5, 0, 100);
    this.annoyance = Math.max(0, this.annoyance - 0.5);
    this.setMood(this.stats.affection > 60 ? 'happy' : 'shy', 15);
  }

  /** Returns the grab level: 1 = surprised, 2 = displeased, 3 = angry. */
  onGrab(): 1 | 2 | 3 {
    this.interacted();
    this.annoyance = clamp(this.annoyance + 1, 0, 3);
    this.cooldown = TUNING.annoyanceCooldown;
    const level = Math.round(this.annoyance) as 1 | 2 | 3;
    if (level >= 3) { this.setMood('angry', 20); this.stats.affection = clamp(this.stats.affection - 2, 0, 100); }
    else if (level === 2) this.setMood('surprised', 6);
    else this.setMood('surprised', 4);
    return level;
  }

  /** Called every frame while she is being held. */
  onDragTick(dt: number): void {
    this.idleFor = 0;
    this.annoyance = clamp(this.annoyance + dt * 0.08, 0, 3);
    this.cooldown = TUNING.annoyanceCooldown;
  }

  onChat(emotion: Emotion): void {
    this.interacted();
    this.stats.affection = clamp(this.stats.affection + 0.5, 0, 100);
    this.setMood(emotion, 20);
  }

  isAngry(): boolean { return this.stats.mood === 'angry'; }
  isSleepy(): boolean { return this.stats.energy < 22; }

  update(dt: number, state: PetState): void {
    this.idleFor += dt;
    const before = Math.round(this.stats.energy);
    if (state === 'sleeping') this.stats.energy = clamp(this.stats.energy + dt * 1.6, 0, 100);
    else if (state === 'run') this.stats.energy = clamp(this.stats.energy - dt * 0.9, 0, 100);
    else if (state === 'walkLeft' || state === 'walkRight') this.stats.energy = clamp(this.stats.energy - dt * 0.25, 0, 100);
    else this.stats.energy = clamp(this.stats.energy - dt * 0.03, 0, 100);
    if (Math.round(this.stats.energy) !== before) this.touch();

    if (this.cooldown > 0) this.cooldown -= dt;
    else if (this.annoyance > 0) { this.annoyance = Math.max(0, this.annoyance - 1); this.cooldown = TUNING.annoyanceCooldown; }

    if (this.moodTimer > 0) {
      this.moodTimer -= dt;
    } else {
      const resting: Emotion = this.isSleepy() ? 'sleepy' : 'neutral';
      if (this.stats.mood !== resting) { this.stats.mood = resting; this.touch(); }
    }
    if (this.dirty) { this.dirty = false; this.onChange({ ...this.stats }); }
  }
}

import { describe, expect, it } from 'vitest';
import { EmotionSystem } from '../src/engine/EmotionSystem';
import { TUNING } from '../src/config/petConfig';

const fresh = () => new EmotionSystem({ mood: 'neutral', affection: 50, energy: 80, interactionCount: 0 });

describe('EmotionSystem', () => {
  it('grabbing escalates: surprised, displeased, angry — and stops at 3', () => {
    const e = fresh();
    expect(e.onGrab()).toBe(1);
    expect(e.onGrab()).toBe(2);
    expect(e.onGrab()).toBe(3);
    expect(e.onGrab()).toBe(3);
    expect(e.isAngry()).toBe(true);
  });

  it('calms down after being left alone', () => {
    const e = fresh();
    e.onGrab(); e.onGrab(); e.onGrab();
    for (let t = 0; t < TUNING.annoyanceCooldown * 5 + 30; t += 0.5) e.update(0.5, 'idle');
    expect(e.annoyance).toBe(0);
    expect(e.stats.mood).toBe('neutral');
  });

  it('petting raises affection but never above 100', () => {
    const e = fresh();
    for (let i = 0; i < 200; i++) e.onPet();
    expect(e.stats.affection).toBe(100);
    expect(e.stats.mood).toBe('happy');
    expect(e.stats.interactionCount).toBe(200);
  });

  it('sleeping restores energy, running spends it, both stay in 0–100', () => {
    const e = fresh();
    for (let i = 0; i < 400; i++) e.update(0.5, 'run');
    expect(e.stats.energy).toBe(0);
    expect(e.isSleepy()).toBe(true);
    for (let i = 0; i < 400; i++) e.update(0.5, 'sleeping');
    expect(e.stats.energy).toBe(100);
  });

  it('reports changes so they can be saved', () => {
    const saved: number[] = [];
    const e = new EmotionSystem({ mood: 'neutral', affection: 10, energy: 80, interactionCount: 0 }, (s) => saved.push(s.affection));
    e.onPet();
    e.update(0.016, 'petting');
    expect(saved).toEqual([11.5]);
  });
});

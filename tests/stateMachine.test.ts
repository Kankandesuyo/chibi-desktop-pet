import { describe, expect, it } from 'vitest';
import { PET_STATES } from '../shared/types';
import { PetStateMachine, STATE_SPECS } from '../src/engine/PetStateMachine';
import { BehaviorScheduler, type SchedulerContext } from '../src/engine/BehaviorScheduler';

const run = (m: PetStateMachine, seconds: number, dt = 1 / 60): void => {
  for (let t = 0; t < seconds; t += dt) m.update(dt);
};

describe('PetStateMachine', () => {
  it('has a spec for every state', () => {
    for (const s of PET_STATES) expect(STATE_SPECS[s]).toBeDefined();
  });

  it('autonomous walking cannot interrupt a drag', () => {
    const m = new PetStateMachine(() => 0.5);
    m.force('dragStart');
    expect(m.request('walkLeft')).toBe(false);
    expect(m.request('happy')).toBe(false);
    run(m, 0.3);
    expect(m.state).toBe('dragging');
    expect(m.request('walkRight')).toBe(false);
    expect(m.request('struggling')).toBe(true);
  });

  it('release goes falling -> landing -> idle and never gets stuck', () => {
    const m = new PetStateMachine(() => 0.5);
    m.force('dragging');
    m.force('falling');
    expect(m.request('walkLeft')).toBe(false);
    expect(m.request('petting')).toBe(false);
    m.force('landing');
    run(m, 0.5);
    expect(m.state).toBe('idle');
  });

  it('can be caught again in mid-air', () => {
    const m = new PetStateMachine();
    m.force('falling');
    expect(m.request('dragStart')).toBe(true);
  });

  it('sleeping only accepts waking or being picked up', () => {
    const m = new PetStateMachine(() => 0);
    m.force('sleeping');
    for (const s of ['walkLeft', 'jump', 'happy', 'lookAround', 'talking', 'petting'] as const) {
      expect(m.request(s)).toBe(false);
    }
    expect(m.request('waking')).toBe(true);
    run(m, 1);
    expect(m.state).toBe('idle');
  });

  it('user interaction outranks autonomous behaviour, not the other way round', () => {
    const m = new PetStateMachine(() => 0.5);
    m.force('walkLeft');
    expect(m.request('petting')).toBe(true);
    expect(m.request('walkRight')).toBe(false);
    expect(m.request('lookAround')).toBe(false);
  });

  it('turning leads into walking the same way', () => {
    const m = new PetStateMachine(() => 0);
    m.request('turnRight');
    run(m, 0.3);
    expect(m.state).toBe('walkRight');
  });

  it('every timed state eventually returns to idle or an untimed state', () => {
    for (const s of PET_STATES) {
      const m = new PetStateMachine(() => 1);
      m.force(s);
      run(m, 120, 1 / 20);
      expect(['idle', 'dragging', 'falling']).toContain(m.state);
    }
  });

  it('petting can be refreshed while it is running', () => {
    const m = new PetStateMachine();
    m.request('petting');
    run(m, 0.8);
    expect(m.request('petting')).toBe(true);
    run(m, 0.8);
    expect(m.state).toBe('petting');
  });

  it('notifies listeners once per real change', () => {
    const m = new PetStateMachine();
    const seen: string[] = [];
    m.onTransition((next, prev) => seen.push(`${prev}>${next}`));
    m.request('happy');
    m.request('happy');
    expect(seen).toEqual(['idle>happy']);
  });
});

describe('scenes (eating)', () => {
  const ctx = (scenes?: SchedulerContext['scenes']): SchedulerContext => ({
    state: 'idle', autoMove: true, frequency: 1, sleepy: false, idleFor: 0, angry: false, nightTime: false, scenes,
  });
  const picks = (scenes?: SchedulerContext['scenes']): Set<string> => {
    let seed = 1;
    const s = new BehaviorScheduler(() => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; });
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) { const a = s.update(1, ctx(scenes)); if (a) seen.add(a); }
    return seen;
  };

  it('is only picked at random for characters that have the art', () => {
    expect(picks().has('eating')).toBe(false);
    expect(picks(['eating']).has('eating')).toBe(true);
  });

  it('runs exactly as long as the engine says (whole bites), then returns to idle', () => {
    const m = new PetStateMachine(() => 0);
    m.request('eating');
    m.setDuration(5.6);
    run(m, 5.5);
    expect(m.state).toBe('eating');
    run(m, 0.2);
    expect(m.state).toBe('idle');
  });

  it('gives way to being petted or picked up', () => {
    const m = new PetStateMachine();
    m.request('eating');
    expect(m.request('petting')).toBe(true);
  });
});

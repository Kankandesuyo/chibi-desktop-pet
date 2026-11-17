import { describe, expect, it } from 'vitest';
import { PET_STATES } from '../shared/types';
import { PetStateMachine, STATE_SPECS } from '../src/engine/PetStateMachine';

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

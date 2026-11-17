import { describe, expect, it } from 'vitest';
import { CHARACTER_HALF_WIDTH } from '../shared/constants';
import { MovementController } from '../src/engine/MovementController';

const area = { x: 0, y: 0, width: 1920, height: 1040 };

describe('MovementController', () => {
  it('falls with gravity and lands exactly on the floor', () => {
    const mv = new MovementController({ x: 500, y: 300 }, area);
    mv.gravity = true;
    mv.startFall();
    let landed: number | null = null;
    for (let i = 0; i < 600 && landed === null; i++) landed = mv.update(1 / 60, 'falling', 1).landedWith;
    expect(landed).not.toBeNull();
    expect(landed as number).toBeGreaterThan(500);
    expect(mv.pos.y).toBe(1040);
    expect(mv.isAirborne()).toBe(false);
  });

  it('never walks off either edge of the work area', () => {
    const mv = new MovementController({ x: 200, y: 1040 }, area);
    let hit: string | null = null;
    for (let i = 0; i < 60 * 60; i++) hit = mv.update(1 / 60, 'walkLeft', 2).hitEdge ?? hit;
    expect(hit).toBe('left');
    expect(mv.pos.x).toBe(CHARACTER_HALF_WIDTH);
    for (let i = 0; i < 60 * 120; i++) mv.update(1 / 60, 'walkRight', 2);
    expect(mv.pos.x).toBe(1920 - CHARACTER_HALF_WIDTH);
  });

  it('works on a second monitor with an offset work area', () => {
    const second = { x: 1920, y: -200, width: 2560, height: 1400 };
    const mv = new MovementController({ x: 2500, y: 400 }, second);
    mv.startFall(9999);
    for (let i = 0; i < 600; i++) mv.update(1 / 60, 'falling', 1);
    expect(mv.pos.y).toBe(1200);
    expect(mv.pos.x).toBeLessThanOrEqual(1920 + 2560 - CHARACTER_HALF_WIDTH);
  });

  it('with gravity off she is never airborne, so she stays wherever she is put', () => {
    const mv = new MovementController({ x: 500, y: 300 }, area);
    expect(mv.isAirborne()).toBe(false);
    for (let i = 0; i < 120; i++) mv.update(1 / 60, 'walkRight', 1);
    expect(mv.pos.y).toBe(300);
    expect(mv.pos.x).toBeGreaterThan(500);
    mv.gravity = true;
    expect(mv.isAirborne()).toBe(true);
  });

  it('stays put while idle', () => {
    const mv = new MovementController({ x: 500, y: 1040 }, area);
    expect(mv.update(1, 'idle', 1).moved).toBe(false);
    expect(mv.pos).toEqual({ x: 500, y: 1040 });
  });
});

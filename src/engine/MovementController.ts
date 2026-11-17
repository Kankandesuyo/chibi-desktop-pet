import { CHARACTER_HALF_WIDTH } from '../../shared/constants';
import type { PetState, Point, Rect } from '../../shared/types';
import { TUNING } from '../config/petConfig';

export type Facing = 'left' | 'right';

export interface MoveResult {
  moved: boolean;
  /** She walked into a screen edge on this side. */
  hitEdge: Facing | null;
  /** Set on the frame she touches the floor: impact speed in px/s. */
  landedWith: number | null;
}

/** World position of the feet (screen DIP), walking, gravity and the floor. No rendering here. */
export class MovementController {
  pos: Point;
  vx = 0;
  vy = 0;
  facing: Facing = 'left';
  workArea: Rect;
  size = 1;
  /** Off = she stands wherever she was put, so nothing ever counts as "in the air". */
  gravity = false;
  /** Walking pace of this character relative to the default (art with long strides walks faster). */
  walkScale = 1;

  constructor(start: Point, workArea: Rect) {
    this.pos = { ...start };
    this.workArea = { ...workArea };
  }

  get floorY(): number { return this.workArea.y + this.workArea.height; }
  get minX(): number { return this.workArea.x + CHARACTER_HALF_WIDTH * this.size; }
  get maxX(): number { return this.workArea.x + this.workArea.width - CHARACTER_HALF_WIDTH * this.size; }
  isAirborne(): boolean { return this.gravity && this.pos.y < this.floorY - 1; }

  /** Start a fall, optionally carrying some sideways speed from the drag. */
  startFall(vx = 0): void {
    this.vy = 0;
    this.vx = Math.max(-500, Math.min(500, vx));
  }

  /** Sideways speed on screen (px/s) while in this state; 0 when the state does not travel. */
  speedOf(state: PetState, speed: number): number {
    // Small pets take small steps, but not proportionally tiny ones.
    const stride = (0.45 + 0.55 * this.size) * speed;
    if (state === 'run') return TUNING.runSpeed * stride;
    if (state === 'walkLeft' || state === 'walkRight') return TUNING.walkSpeed * this.walkScale * stride;
    return 0;
  }

  update(dt: number, state: PetState, speed: number): MoveResult {
    const before = { ...this.pos };
    const result: MoveResult = { moved: false, hitEdge: null, landedWith: null };

    if (state === 'walkLeft' || state === 'walkRight' || state === 'run') {
      if (state === 'walkLeft') this.facing = 'left';
      if (state === 'walkRight') this.facing = 'right';
      const dir = this.facing === 'left' ? -1 : 1;
      const v = this.speedOf(state, speed);
      this.pos.x += dir * v * dt;
      if (this.pos.x <= this.minX) { this.pos.x = this.minX; result.hitEdge = 'left'; }
      if (this.pos.x >= this.maxX) { this.pos.x = this.maxX; result.hitEdge = 'right'; }
    } else if (state === 'falling') {
      this.vy = Math.min(TUNING.maxFallSpeed, this.vy + TUNING.gravity * dt);
      this.pos.y += this.vy * dt;
      this.pos.x = Math.max(this.minX, Math.min(this.maxX, this.pos.x + this.vx * dt));
      this.vx *= Math.max(0, 1 - dt * 2.5);
      if (this.pos.y >= this.floorY) {
        this.pos.y = this.floorY;
        result.landedWith = this.vy;
        this.vy = 0;
        this.vx = 0;
      }
    }
    result.moved = Math.round(before.x) !== Math.round(this.pos.x) || Math.round(before.y) !== Math.round(this.pos.y);
    return result;
  }
}

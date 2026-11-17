import { Container, Graphics, MeshPlane, Sprite, type Texture } from 'pixi.js';
import { CHARACTER_HEIGHT } from '../../shared/constants';
import type { PetState } from '../../shared/types';
import { TUNING } from '../config/petConfig';
import type { HoldAct } from './DragController';
import type { Facing } from './MovementController';
import type { Pose, SpriteManager } from './SpriteManager';

export type IdleVariant = 'none' | 'sway';

export interface AnimInput {
  state: PetState;
  /** Seconds in the current state / 0–1 progress through it. */
  time: number;
  progress: number;
  /** Seconds since start. */
  clock: number;
  facing: Facing;
  idleVariant: IdleVariant;
  size: number;
  blinkClosed: boolean;
  /** Drag physics. */
  swing: number;
  lagX: number;
  lagY: number;
  /** Trailing lower body (radians), stretch along the body, struggle shake, leg kicking 0…1. */
  tail: number;
  stretch: number;
  wiggle: number;
  wiggleX: number;
  kick: number;
  act: HoldAct;
  /** Seconds held in this grab (0 when not held). */
  heldFor: number;
  /** Sideways travel speed on screen, px/s (0 when standing). */
  speed: number;
  /** Where the cursor holds her, relative to the feet anchor (px). */
  grabPoint: { x: number; y: number } | null;
  /** -1…1: lean toward the pointer (petting / hover). */
  lean: number;
  /** 0…1 strength of the landing squash. */
  impact: number;
}

interface Transform { dx: number; dy: number; sx: number; sy: number; rot: number; skew: number }

/** Secondary motion of hair and skirt, in canvas pixels. */
interface Soft { wind: number; wave: number; speed: number; lift: number; flare: number }

const DEG = Math.PI / 180;
const GRID_X = 10;
const GRID_Y = 16;
const RIG_STATES: PetState[] = ['walkLeft', 'walkRight', 'turnLeft', 'turnRight', 'run'];

/**
 * A picture drawn on a deformable grid: the lower part (hair ends, skirt) can sway while the head and
 * the feet stay put. This is a cheap stand-in for real animation frames — the art is still one picture.
 */
class SoftLayer {
  readonly mesh: MeshPlane;
  private readonly base: Float32Array;

  constructor(texture: Texture, anchor: [number, number]) {
    this.mesh = new MeshPlane({ texture, verticesX: GRID_X, verticesY: GRID_Y });
    this.mesh.pivot.set(anchor[0], anchor[1]);
    const { width, height } = texture;
    this.base = new Float32Array(GRID_X * GRID_Y * 2);
    for (let y = 0; y < GRID_Y; y++) for (let x = 0; x < GRID_X; x++) {
      const i = (y * GRID_X + x) * 2;
      this.base[i] = (x / (GRID_X - 1)) * width;
      this.base[i + 1] = (y / (GRID_Y - 1)) * height;
    }
  }

  set texture(t: Texture) { if (this.mesh.texture !== t) this.mesh.texture = t; }

  /** Moves the grid vertices: `fn(x, y)` returns the offset for the vertex at texture pixel (x, y). */
  deform(fn: (x: number, y: number) => [number, number]): void {
    const buf = this.mesh.geometry.getBuffer('aPosition');
    const pos = buf.data as Float32Array;
    if (pos.length !== this.base.length) return;            // geometry rebuilt with another size; skip a frame
    for (let i = 0; i < pos.length; i += 2) {
      const [ox, oy] = fn(this.base[i] as number, this.base[i + 1] as number);
      pos[i] = (this.base[i] as number) + ox;
      pos[i + 1] = (this.base[i + 1] as number) + oy;
    }
    buf.update();
  }
}

const smooth = (t: number): number => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/**
 * Turns "state + time" into what is on screen. Each state shows one picture (no frame sequences);
 * motion is procedural: body bob/squash/tilt, swinging legs on the side views, and hair/skirt sway on a
 * deformable mesh. It knows nothing about the mouse — interaction only reaches it through AnimInput.
 */
export class AnimationController {
  /** Positioned at the feet anchor by the engine. */
  readonly root = new Container();
  private body = new Container();
  /** Everything in canvas pixels (scaled to the pet size), origin at the feet anchor. */
  private canvasLayer = new Container();
  private legs = new Container();
  private backLeg = new Sprite();
  private frontLeg = new Sprite();
  private cur: SoftLayer;
  private prev: SoftLayer;
  private blush = new Graphics();
  private pose: Pose;
  private prevPose: Pose | null = null;
  private fade = 1;
  /** Length of the running crossfade (pose changes are slower than walk-frame changes). */
  private fadeMs: number = TUNING.crossfadeMs;
  private applied: Transform = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, skew: 0 };
  private soft: Soft = { wind: 0, wave: 0, speed: 1.7, lift: 0, flare: 0 };
  private wavePhase = 0;
  private stepPhase = 0;
  private framePhase = 0;
  private framePose: Pose | null = null;
  private stride = 0;
  private blushAlpha = 0;
  private baseScale = 1;
  /** 0 = feet planted on the floor, 1 = hanging / in the air (legs and skirt swing freely). */
  private loose = 0;

  constructor(private readonly sprites: SpriteManager) {
    this.pose = sprites.pose('idle');
    const anchor = sprites.canvas.anchor;
    this.prev = new SoftLayer(this.pose.texture, anchor);
    this.cur = new SoftLayer(this.pose.texture, anchor);
    this.prev.mesh.visible = false;
    this.backLeg.tint = 0xd8cfcb;                // the far leg is a touch darker
    this.legs.addChild(this.backLeg, this.frontLeg);
    this.legs.visible = false;
    this.canvasLayer.addChild(this.legs, this.prev.mesh, this.cur.mesh, this.blush);
    this.body.addChild(this.canvasLayer);
    this.root.addChild(this.body);
  }

  get currentPose(): Pose { return this.pose; }
  /** True while something is visibly moving faster than breathing (used to pick the frame rate). */
  get fading(): boolean { return this.fade < 1; }

  setPose(pose: Pose, instant = false): void {
    if (pose.name === this.pose.name) return;
    this.prevPose = this.pose;
    this.prev.texture = this.cur.mesh.texture;
    this.prev.mesh.alpha = 1;
    this.prev.mesh.visible = !instant;
    this.pose = pose;
    this.fade = instant ? 1 : 0;
    this.fadeMs = TUNING.crossfadeMs;
    this.drawBlush();
  }

  private drawBlush(): void {
    this.blush.clear();
    const [ax, ay] = this.sprites.canvas.anchor;
    for (const [x, y] of this.pose.cheeks) this.blush.ellipse(x - ax, y - ay, 13, 7).fill({ color: 0xff7f96, alpha: 0.55 });
  }

  private rigActive(state: PetState, pose: Pose | null): boolean {
    return Boolean(pose?.rig) && RIG_STATES.includes(state);
  }

  /** Real drawn frames for this state, when the manifest provides them (they beat the procedural rig). */
  private sequenceFor(i: AnimInput): { frames: Pose[]; fps: number; stepLength: number; stepsPerCycle: number; blend: boolean } | null {
    const key = i.state === 'run' ? `run:${i.facing}` : i.state;
    return this.sprites.sequence(key);
  }

  /** The procedural body motion for each state. Pure function of the input. */
  private target(i: AnimInput, rig: boolean): Transform {
    const t: Transform = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, skew: 0 };
    const s = i.size;
    const breath = Math.sin(i.clock * 2.2);
    t.sy = 1 + breath * 0.011;
    t.sx = 1 - breath * 0.006;
    const dir = i.facing === 'left' ? -1 : 1;

    switch (i.state) {
      case 'idle':
        if (i.idleVariant === 'sway') { t.rot = Math.sin(i.clock * 2.6) * 3.2 * DEG; t.skew = Math.sin(i.clock * 2.6 + 0.6) * 2 * DEG; }
        else t.rot = Math.sin(i.clock * 0.9) * 0.6 * DEG;
        t.rot += i.lean * 2 * DEG;
        break;
      case 'talking':
        t.dy = -Math.abs(Math.sin(i.clock * 7)) * 3 * s;
        t.rot = Math.sin(i.clock * 3.5) * 1.5 * DEG;
        break;
      case 'blink':
        t.rot = Math.sin(Math.min(1, i.time * 4) * Math.PI) * 3 * DEG + 2 * DEG;
        break;
      case 'lookAround': {
        const side = Math.sin(i.time * 2.6);
        t.skew = side * 5 * DEG;
        t.rot = side * 2.5 * DEG;
        break;
      }
      case 'turnLeft':
      case 'turnRight':
        // A light squeeze sells the turn; the picture itself is swapped (never mirrored).
        t.sx *= 1 - Math.sin(i.progress * Math.PI) * 0.16;
        break;
      case 'walkLeft':
      case 'walkRight':
      case 'run': {
        const run = i.state === 'run';
        if (this.framePose) {
          t.rot = dir * (run ? 4 : 0.8) * DEG;
          t.dy = run ? -Math.abs(Math.sin(this.framePhase * Math.PI / 2)) * 4 * s : 0;
        } else if (rig) {
          // The legs do the walking: the hips dip as the legs spread so the feet stay on the floor,
          // plus a little side-to-side sway and a forward lean.
          t.dy = this.hipDrop() * this.baseScale;
          t.rot = Math.sin(this.stepPhase * 2) * (run ? 1.6 : 1) * DEG + dir * (run ? 4 : 1.2) * DEG;
          t.sy *= 1 + Math.cos(this.stepPhase * 2) * 0.008;
        } else {
          const ph = i.time * (run ? 15 : 9);
          t.dy = -Math.abs(Math.sin(ph)) * (run ? 9 : 5) * s;
          t.rot = (run ? dir * 5 * DEG : 0) + Math.sin(ph) * 2.2 * DEG;
          t.skew = -dir * (run ? 4 : 2) * DEG;
        }
        break;
      }
      case 'jump': {
        const up = Math.sin(i.progress * Math.PI);
        t.dy = -up * TUNING.jumpHeight * s;
        const squash = i.progress < 0.12 || i.progress > 0.9 ? 0.1 : 0;
        t.sy = 1 + up * 0.06 - squash;
        t.sx = 1 - up * 0.04 + squash;
        break;
      }
      case 'happy':
        t.dy = -Math.abs(Math.sin(i.time * 7)) * 8 * s;
        t.rot = Math.sin(i.time * 7) * 2.5 * DEG;
        break;
      case 'shy':
        t.rot = Math.sin(i.time * 3) * 3 * DEG;
        t.skew = Math.sin(i.time * 3 + 1) * 2.5 * DEG;
        t.sy *= 0.985;
        break;
      case 'petting':
        t.rot = i.lean * 4 * DEG + Math.sin(i.clock * 9) * 1.4 * DEG;
        t.sy *= 0.975;
        t.sx *= 1.012;
        break;
      case 'angry':
        if (i.time < 0.5) t.dx = Math.sin(i.time * 60) * 2.5 * s;
        t.rot = Math.sin(i.time * 2) * 1 * DEG;
        break;
      case 'sleeping':
        t.rot = 5 * DEG + Math.sin(i.clock * 1.3) * 1.5 * DEG;
        t.sy = 0.97 + Math.sin(i.clock * 1.3) * 0.02;
        t.sx = 1.01;
        break;
      case 'waking': {
        const k = Math.sin(i.progress * Math.PI);
        t.sy = 1 + k * 0.05;
        t.sx = 1 - k * 0.03;
        break;
      }
      case 'dragStart':
      case 'dragging':
      case 'struggling': {
        // She hangs from the hand: a pendulum that stretches when pulled and bends where the legs trail.
        const bend = Math.max(-0.5, Math.min(0.5, i.tail - i.swing));
        t.sy *= 1.02 + i.stretch;
        t.sx *= 0.99 - i.stretch * 0.55;
        t.rot = i.swing + i.wiggle;
        t.skew = bend * 0.25;
        t.dx = i.wiggleX * s;
        if (i.state === 'struggling') {
          t.sy *= 1 + Math.abs(i.wiggle) * 0.25;
        } else if (i.act === 'peek') {
          // Looks about: slow tilt from side to side with a small pause at each end.
          const look = Math.sin(i.clock * 2.3);
          t.rot += Math.sign(look) * Math.pow(Math.abs(look), 0.6) * 4.5 * DEG;
        } else if (i.act === 'limp') {
          // Given up: hangs longer and lower, drifting slowly.
          t.sy *= 1.025;
          t.sx *= 0.985;
          t.rot += Math.sin(i.clock * 0.9) * 2.5 * DEG;
        } else if (i.act === 'kick') {
          t.sy *= 1 + Math.sin(i.clock * 17) * 0.012 * i.kick;
        }
        break;
      }
      case 'falling':
        t.sy = 1.06 + i.stretch;
        t.sx = 0.96;
        t.rot = i.swing;
        t.skew = Math.max(-0.5, Math.min(0.5, i.tail - i.swing)) * 0.25;
        break;
      case 'landing': {
        const p = i.progress;
        const bounce = Math.exp(-p * 5) * Math.cos(p * 16);
        const amp = 0.14 + 0.16 * i.impact;
        t.sy = 1 - amp * bounce;
        t.sx = 1 + amp * 0.8 * bounce;
        break;
      }
    }
    return t;
  }

  /** How far the hips must drop (canvas px) so the planted foot touches the floor at the current stride. */
  private hipDrop(): number {
    const rig = this.pose.rig;
    if (!rig) return 0;
    const legLen = this.sprites.canvas.anchor[1] - rig.hip[1];
    const a = Math.abs(this.stride * Math.sin(this.stepPhase));
    return legLen * (1 - Math.cos(a));
  }

  /** Target hair/skirt motion for the state (canvas px). */
  private softTarget(i: AnimInput, rig: boolean): Soft {
    const back = i.facing === 'left' ? 1 : -1;               // hair trails opposite to the walking direction
    switch (i.state) {
      case 'walkLeft': case 'walkRight':
        return { wind: back * (rig ? 5 : 3), wave: rig ? 2.2 : 1.5, speed: 9, lift: 0, flare: 0 };
      case 'run':
        return { wind: back * 11, wave: 4, speed: 15, lift: -2, flare: 0 };
      case 'turnLeft': case 'turnRight':
        return { wind: back * 3, wave: 2, speed: 6, lift: 0, flare: 0 };
      case 'talking': return { wind: 0, wave: 2.4, speed: 3.2, lift: 0, flare: 0 };
      case 'happy': return { wind: 0, wave: 3.5, speed: 7, lift: -2, flare: 0.02 };
      case 'jump': return { wind: 0, wave: 2, speed: 6, lift: i.progress < 0.5 ? 6 : -9, flare: i.progress < 0.5 ? 0 : 0.05 };
      case 'falling': return { wind: this.trail(i), wave: 3, speed: 9, lift: -12, flare: 0.06 };
      case 'landing': return { wind: 0, wave: 0, speed: 2, lift: 0, flare: 0.1 * (0.5 + i.impact) * Math.exp(-i.progress * 4) * Math.cos(i.progress * 12) };
      case 'dragStart': case 'dragging': case 'struggling': {
        // Legs, skirt and hair ends trail the body; pulled up they drag down, dropped they float up and flare.
        const limp = i.act === 'limp' && i.state !== 'struggling';
        return {
          wind: this.trail(i),
          wave: (limp ? 1.2 : 2.4) + i.kick * 5.5,
          speed: (limp ? 2.2 : 4.5) + i.kick * 17,
          lift: 3 + i.stretch * 70,
          flare: Math.max(0, -i.stretch) * 0.5 + i.kick * 0.015,
        };
      }
      case 'shy': case 'petting': return { wind: i.lean * 2, wave: 1.8, speed: 3, lift: 0, flare: 0 };
      case 'sleeping': return { wind: 0, wave: 1, speed: 1.1, lift: 0, flare: 0 };
      case 'lookAround': return { wind: -Math.sin(i.time * 2.6) * 3, wave: 2, speed: 2, lift: 0, flare: 0 };
      default: return { wind: 0, wave: i.idleVariant === 'sway' ? 2.8 : 2, speed: i.idleVariant === 'sway' ? 2.6 : 1.7, lift: 0, flare: 0 };
    }
  }

  /** Sideways trail of the lower body behind the swing, canvas px. */
  private trail(i: AnimInput): number {
    return Math.max(-34, Math.min(34, (i.tail - i.swing) * 85 - i.lagX * 0.5));
  }

  private deformLayer(layer: SoftLayer, pose: Pose): void {
    const ay = this.sprites.canvas.anchor[1];
    const [bx, by, bw, bh] = pose.bounds;
    const shoulder = by + bh * 0.36;                           // above this: head, never moves
    const peak = Math.max(shoulder + 20, pose.hem - 24);        // strongest just above the hem
    const feet = ay;                                            // feet stay planted
    const cx = bx + bw / 2;
    const half = Math.max(40, bw / 2);
    const { wind, wave, lift, flare } = this.soft;
    const ph = this.wavePhase;
    const loose = this.loose;
    const bottom = Math.max(peak + 1, Math.min(feet, by + bh));
    layer.deform((x, y) => {
      let w: number;
      if (y <= shoulder) w = 0;
      else if (y <= peak) w = smooth((y - shoulder) / (peak - shoulder));
      else w = 1 - smooth((y - peak) / Math.max(1, feet - peak));
      if (loose > 0 && y > shoulder) {
        // In the air nothing pins the feet: the further from the hand, the more it swings.
        const free = 0.25 + 0.95 * smooth((y - shoulder) / (bottom - shoulder));
        w += (free - w) * loose;
      }
      if (w <= 0) return [0, 0];
      const side = 0.55 + 0.9 * Math.min(1, Math.abs(x - cx) / half);
      const wv = Math.sin(ph - y * 0.018 + x * 0.006);
      return [w * (side * (wind + wave * wv) + (x - cx) * flare), w * (lift + wave * 0.25 * Math.cos(ph * 0.9 - y * 0.02))];
    });
  }

  update(dt: number, i: AnimInput): void {
    this.baseScale = (CHARACTER_HEIGHT * i.size) / this.sprites.canvas.standHeight;
    this.canvasLayer.scale.set(this.baseScale);

    const seq = this.sequenceFor(i);
    const rig = !seq && this.rigActive(i.state, this.pose);
    const prevRig = this.rigActive(i.state, this.prevPose);

    // Picture for the main layer: drawn frame, rig body, blink frame, or the pose itself.
    const blinkPose = i.blinkClosed ? this.sprites.blinkFor(this.pose.name) : null;
    let frame: Pose | null = null;
    if (seq) {
      // When the art says how far one step reaches, the legs keep time with the ground she covers
      // so she neither marches on the spot nor skates.
      let fps = seq.fps;
      if (seq.stepLength > 0 && i.speed > 0) {
        const grip = i.state === 'run' ? 0.55 : 0.72;                       // a little slip reads better than a slow shuffle
        fps = (i.speed / (seq.stepLength * this.baseScale * grip)) * (seq.frames.length / seq.stepsPerCycle);
        fps = Math.max(2.5, Math.min(24, fps));
      }
      // Walks set off from the feet-together frame; scenes (eating…) start at their first frame.
      if (!this.framePose) this.framePhase = seq.stepLength > 0 && seq.frames.length > 2 ? 1 : 0;
      this.framePhase += dt * fps;
      frame = seq.frames[Math.floor(this.framePhase) % seq.frames.length] ?? null;
      // Dissolve from one drawn frame into the next instead of a hard cut: all the way through the frame when
      // the drawings are close (it reads as motion at the screen's frame rate), briefly when they are far apart.
      if (frame && this.framePose && frame !== this.framePose && this.fade >= 1) {
        this.prevPose = this.framePose;
        this.prev.texture = this.framePose.texture;
        this.prev.mesh.visible = true;
        this.fade = 0;
        this.fadeMs = seq.blend ? 900 / fps : Math.min(50, 220 / fps);
      }
    } else {
      this.framePhase = 0;
    }
    this.cur.texture = frame ? frame.texture : rig && this.pose.rig ? this.pose.rig.body : blinkPose ? blinkPose.texture : this.pose.texture;
    this.framePose = frame;
    if (this.prevPose && this.fade < 1) this.prev.texture = prevRig && this.prevPose.rig ? this.prevPose.rig.body : this.prevPose.texture;

    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + (dt * 1000) / this.fadeMs);
      // The new picture fades in over the old one, and only then the old one fades away underneath,
      // so she is never see-through while changing.
      this.cur.mesh.alpha = Math.min(1, this.fade / 0.6);
      this.prev.mesh.alpha = this.fade < 0.6 ? 1 : 1 - (this.fade - 0.6) / 0.4;
      if (this.fade >= 1) { this.prev.mesh.visible = false; this.cur.mesh.alpha = 1; this.prevPose = null; }
    }

    // ---- legs (side views only) ----
    const walking = i.state === 'walkLeft' || i.state === 'walkRight' || i.state === 'run';
    const run = i.state === 'run';
    const targetStride = walking ? (run ? 30 : 19) * DEG : 0;
    this.stride += (targetStride - this.stride) * Math.min(1, dt * 10);
    if (walking) this.stepPhase += dt * (run ? 14 : 8.5);
    else this.stepPhase += (Math.round(this.stepPhase / Math.PI) * Math.PI - this.stepPhase) * Math.min(1, dt * 10);   // settle feet together
    const legPose = rig ? this.pose : prevRig && !seq ? this.prevPose : null;
    if (legPose?.rig) {
      const r = legPose.rig;
      const [ax, ay] = this.sprites.canvas.anchor;
      const forward = i.facing === 'left' ? 1 : -1;              // +rotation moves the foot to the left
      const lw = r.leg.width, lh = r.leg.height;
      for (const [leg, sign, shift] of [[this.frontLeg, 1, 0], [this.backLeg, -1, -forward * 5]] as const) {
        leg.texture = r.leg;
        leg.anchor.set((r.hip[0] - r.origin[0]) / lw, (r.hip[1] - r.origin[1]) / lh);
        const swing = Math.sin(this.stepPhase) * sign;
        leg.rotation = forward * this.stride * swing;
        // Lift the foot while it swings forward (the "knee bend" a single picture cannot do).
        const swingingForward = Math.cos(this.stepPhase) * sign > 0;
        const lift = swingingForward ? Math.abs(Math.sin(this.stepPhase * 2)) * (run ? 12 : 7) * (this.stride / (19 * DEG)) : 0;
        leg.position.set(r.hip[0] - ax + shift, r.hip[1] - ay - lift);
      }
      this.legs.visible = true;
      this.legs.alpha = rig ? this.cur.mesh.alpha : this.prev.mesh.alpha;
    } else {
      this.legs.visible = false;
    }

    // ---- hair & skirt ----
    const airborne = i.state === 'dragStart' || i.state === 'dragging' || i.state === 'struggling' || i.state === 'falling';
    this.loose += ((airborne ? 1 : 0) - this.loose) * Math.min(1, dt * (airborne ? 9 : 14));
    const st = this.softTarget(i, rig || Boolean(seq));
    const ks = Math.min(1, dt * (airborne ? 14 : 6));
    this.soft.wind += (st.wind - this.soft.wind) * ks;
    this.soft.wave += (st.wave - this.soft.wave) * ks;
    this.soft.speed += (st.speed - this.soft.speed) * ks;
    this.soft.lift += (st.lift - this.soft.lift) * ks;
    this.soft.flare += (st.flare - this.soft.flare) * Math.min(1, dt * 12);
    this.wavePhase += dt * this.soft.speed;
    this.deformLayer(this.cur, this.framePose ?? this.pose);
    if (this.prev.mesh.visible && this.prevPose) this.deformLayer(this.prev, this.prevPose);

    // ---- whole body ----
    const target = this.target(i, rig || Boolean(seq));
    const held = i.state === 'dragStart' || i.state === 'dragging' || i.state === 'struggling';
    const k = Math.min(1, dt * (held ? 30 : 16));
    const a = this.applied;
    a.sx += (target.sx - a.sx) * k;
    a.sy += (target.sy - a.sy) * k;
    a.skew += (target.skew - a.skew) * k;
    a.rot += (target.rot - a.rot) * (held || i.state === 'falling' ? 1 : k);

    let px = target.dx;
    let py = target.dy;
    if (held && i.grabPoint) {
      // Keep the pose's grab point under the cursor and rotate around it.
      const [ax, ay] = this.sprites.canvas.anchor;
      // A real "held" picture hangs from its drawn grab point. Any other picture stays where it is and
      // swings around the spot that was grabbed, so a low grab can never push her out of the window.
      const gx = this.pose.hangs ? (this.pose.grab[0] - ax) * this.baseScale * a.sx : i.grabPoint.x;
      const gy = this.pose.hangs ? (this.pose.grab[1] - ay) * this.baseScale * a.sy : i.grabPoint.y;
      const cos = Math.cos(a.rot), sin = Math.sin(a.rot);
      px = i.grabPoint.x + i.lagX - (gx * cos - gy * sin);
      py = i.grabPoint.y + i.lagY - (gx * sin + gy * cos);
      if (this.pose.hangs) {
        // Grabbed near the feet, a hanging picture would drop below the window: keep its lowest pixel on the floor line.
        const bottom = (this.pose.bounds[1] + this.pose.bounds[3] - ay) * this.baseScale;
        py = Math.min(py, -bottom);
      }
    }
    // Picking up eases into the hanging picture; after that the hand holds her firmly.
    const kp = Math.min(1, dt * (held ? (i.heldFor < 0.25 ? 14 : 45) : 18));
    const direct = i.state === 'jump' || walking || i.state === 'happy';
    a.dx += (px - a.dx) * (direct ? 1 : kp);
    a.dy += (py - a.dy) * (direct ? 1 : kp);

    this.body.position.set(a.dx, a.dy);
    this.body.scale.set(a.sx, a.sy);
    this.body.rotation = a.rot;
    this.body.skew.set(a.skew, 0);

    const blushTarget = (i.state === 'shy' || i.state === 'petting') && this.pose.cheeks.length > 0 ? 1 : 0;
    this.blushAlpha += (blushTarget - this.blushAlpha) * Math.min(1, dt * 8);
    this.blush.alpha = this.blushAlpha;
    this.blush.visible = this.blushAlpha > 0.02;
  }

  /** How far the body is currently drawn from its resting place (px). Large while held / landing. */
  get offsetMagnitude(): number { return Math.abs(this.applied.dx) + Math.abs(this.applied.dy) + Math.abs(this.applied.rot) * 40; }

  /** Stage coordinates (CSS px) -> is that pixel on the character, and on her head? */
  hitTest(x: number, y: number): { hit: boolean; head: boolean } {
    const local = this.cur.mesh.toLocal({ x, y });           // texture pixels (the mesh pivot is the anchor)
    const pose = this.framePose ?? this.pose;
    const hit = this.sprites.hit(pose, local.x, local.y);
    return { hit, head: hit && this.sprites.isHead(pose, local.x, local.y) };
  }

  /** Top of the head relative to the feet anchor, for placing effects (px, y negative = up). */
  headTop(): { x: number; y: number } {
    const [ax, ay] = this.sprites.canvas.anchor;
    const [bx, by, bw] = this.pose.bounds;
    return { x: (bx + bw / 2 - ax) * this.baseScale + this.applied.dx, y: (by - ay) * this.baseScale + this.applied.dy };
  }

  destroy(): void { this.root.destroy({ children: true }); }
}

import 'pixi.js/unsafe-eval';   // lets PixiJS run under a strict CSP (no eval / new Function)
import { Application } from 'pixi.js';
import { FOOT_MARGIN } from '../../shared/constants';
import type { Emotion, InitialData, PetAction, PetAPI, PetNotice, PetState, Settings } from '../../shared/types';
import { LINES, TUNING, pick } from '../config/petConfig';
import { AnimationController, type IdleVariant } from './AnimationController';
import { BehaviorScheduler } from './BehaviorScheduler';
import { BlinkController } from './BlinkController';
import { DragController, type DragEvent } from './DragController';
import { EffectLayer, type EffectKind } from './Effects';
import { EmotionSystem } from './EmotionSystem';
import { InteractionController, type InteractionHost } from './InteractionController';
import { MovementController } from './MovementController';
import { PetStateMachine } from './PetStateMachine';
import { SoundPlayer } from './SoundPlayer';
import { SpriteManager, type Pose } from './SpriteManager';

export interface EngineHooks {
  onReady(warnings: string[]): void;
  onState(state: PetState): void;
  onStats(stats: InitialData['stats']): void;
  say(text: string, ms?: number): void;
}

/** States that only exist when the character's manifest has a drawn sequence for them. */
const SCENE_STATES: readonly PetState[] = ['eating'];

const MOTION_STATES: readonly PetState[] = [
  'walkLeft', 'walkRight', 'run', 'turnLeft', 'turnRight', 'jump', 'dragStart', 'dragging', 'struggling',
  'falling', 'landing', 'happy', 'petting',
];

/**
 * Wires the pieces together and owns the one render loop:
 *   input (InteractionController) -> state (PetStateMachine) -> motion (Movement/Drag) -> picture (Animation)
 */
export class PetEngine implements InteractionHost {
  private app = new Application();
  private sprites: SpriteManager;
  private machine = new PetStateMachine();
  private blink = new BlinkController();
  private scheduler = new BehaviorScheduler();
  /** Scenes (states with their own drawn sequence) this character can play at random; set once the art is loaded. */
  private scenes: PetState[] = [];
  private drag = new DragController({ struggleAfter: TUNING.struggleAfter });
  private holdSayAt = 0;
  /** Idle mouth: she rests with it closed or open, and it flaps while she talks. */
  private mouthShut = false;
  private mouthTimer = 2 + Math.random() * 3;
  private effects = new EffectLayer();
  private sound = new SoundPlayer();
  private anim!: AnimationController;
  private emotion!: EmotionSystem;
  private movement!: MovementController;
  private interaction: InteractionController | null = null;

  private settings: Settings;
  private clock = 0;
  private idleVariant: IdleVariant = 'none';
  private variantLeft = 0;
  private grabPoint: { x: number; y: number } | null = null;
  private impact = 0;
  private lean = 0;
  private leanTarget = 0;
  private effectTimer = 0;
  private poseOverride: string | null = null;
  private afterLanding: PetState | null = null;
  private sentFeet = { x: NaN, y: NaN };
  private statsTimer: number | null = null;
  private visible = true;
  private destroyed = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly api: PetAPI, private readonly hooks: EngineHooks, initial: InitialData) {
    this.settings = initial.settings;
    this.sprites = new SpriteManager(initial.settings.character, initial.customCharacters ?? []);
    this.emotion = new EmotionSystem(initial.stats, (stats) => this.onStatsChanged(stats));
    this.movement = new MovementController(initial.placement.feet, initial.placement.workArea);
    this.movement.size = initial.settings.size;
    this.movement.walkScale = this.sprites.walkSpeedScale;
    this.movement.gravity = initial.settings.gravity;
    this.sound.enabled = initial.settings.sound;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.app.init({
      canvas, backgroundAlpha: 0, antialias: true, autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 3), resizeTo: window, preference: 'webgl',
    });
    await this.sprites.load();
    this.scenes = SCENE_STATES.filter((s) => this.sprites.sequence(s));
    if (this.destroyed) return;

    this.anim = new AnimationController(this.sprites);
    this.app.stage.addChild(this.anim.root);
    this.anim.root.addChild(this.effects.container);

    this.unsubscribe.push(
      this.machine.onTransition((next, prev) => this.onTransition(next, prev)),
      this.api.onPlacement((p) => { this.movement.pos = { ...p.feet }; this.movement.workArea = p.workArea; this.sentFeet = { ...p.feet }; }),
      this.api.onDragUpdate((u) => { if (this.drag.active) { this.drag.onUpdate(u); this.movement.pos = { ...u.feet }; this.sentFeet = { ...u.feet }; } }),
      this.api.onSettings((s) => this.applySettings(s)),
      this.api.onMenuCommand((c) => { if (c.type === 'action') this.perform(c.action, true); else this.api.openChat(); }),
      this.api.onPetNotify((m) => this.onChatEvent(m)),
      this.api.onVisibility((v) => this.setVisible(v)),
    );
    const onVisibility = (): void => this.setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    this.unsubscribe.push(() => document.removeEventListener('visibilitychange', onVisibility));

    this.interaction = new InteractionController(canvas, this);
    this.app.ticker.add((ticker) => this.tick(Math.min(0.05, ticker.deltaMS / 1000)));
    this.hooks.onReady(this.sprites.warnings);
    for (const w of this.sprites.warnings) console.warn('[assets]', w);
    this.hooks.say(pick(LINES.greet), 2600);
    this.poseOverride = 'wave';
    this.machine.request('happy');
  }

  // ------------------------------------------------------------------ loop
  private tick(dt: number): void {
    const speed = this.settings.speed;
    const sdt = dt * speed;
    this.clock += sdt;
    const m = this.machine;

    this.emotion.update(dt, m.state);
    if (m.isDragging()) this.emotion.onDragTick(dt);
    this.drag.update(dt);
    if (m.isDragging()) for (const ev of this.drag.takeEvents()) this.onDragEvent(ev);
    m.update(sdt);

    // Autonomous behaviour (only ever fires while idle).
    const hour = new Date().getHours();
    const auto = this.scheduler.update(dt, {
      state: m.state, autoMove: this.settings.autoMove, frequency: this.settings.autoMoveFrequency,
      sleepy: this.emotion.isSleepy(), idleFor: this.emotion.idleFor, angry: this.emotion.isAngry(),
      nightTime: hour >= 23 || hour < 6, scenes: this.scenes,
    });
    if (auto === 'sway') { this.idleVariant = 'sway'; this.variantLeft = 3; }
    else if (auto === 'hop') { this.poseOverride = 'jump'; m.request('jump'); }
    else if (auto === 'run') { this.movement.facing = Math.random() < 0.5 ? 'left' : 'right'; m.request('run'); }
    else if (auto) m.request(auto);
    if (this.variantLeft > 0 && (this.variantLeft -= dt) <= 0) this.idleVariant = 'none';

    // Movement + physics.
    const move = this.movement.update(dt, m.state, speed);
    if (move.hitEdge) {
      if (m.state === 'run') { this.movement.facing = move.hitEdge === 'left' ? 'right' : 'left'; this.showStatePose('run'); }
      else m.force(move.hitEdge === 'left' ? 'turnRight' : 'turnLeft');
    }
    if (move.landedWith !== null) this.onLanded(move.landedWith);
    // Standing in mid-air (resolution changed, pet resized, taskbar moved…) -> fall to the floor.
    if (!m.isDragging() && m.state !== 'falling' && this.movement.isAirborne()) { this.movement.startFall(); m.force('falling'); }
    this.sendPosition();

    // Timed effects.
    this.effectTimer -= dt;
    if (this.effectTimer <= 0) {
      if (m.state === 'sleeping') { this.spawn('zzz', 18, 6); this.effectTimer = 1.4; }
      else if (m.state === 'petting') { this.spawn('heart', (Math.random() - 0.5) * 50, -4); this.effectTimer = 0.45; }
      else if (m.state === 'struggling') { this.spawn('sweat', (Math.random() - 0.5) * 70, 20); this.effectTimer = 0.3 + Math.random() * 0.35; }
      else if (m.state === 'dragging' && this.drag.act === 'limp') { this.spawn('sweat', (Math.random() - 0.5) * 50, 20); this.effectTimer = 1.3 + Math.random(); }
      else this.effectTimer = 0.2;
    }
    this.lean += (this.leanTarget - this.lean) * Math.min(1, dt * 8);
    this.impact = Math.max(0, this.impact - dt * 0.6);

    this.updateMouth(dt);
    const blinkAllowed = m.is('idle', 'lookAround', 'talking', 'landing', 'waking');
    const blinkClosed = this.blink.update(dt, blinkAllowed);

    const s = this.settings.size;
    // The window can only sit on whole pixels, so walking would move her in uneven 1-px hops. Draw her at
    // the exact position instead: the window is at the rounded spot, the picture makes up the fraction.
    const frac = this.drag.active ? 0 : this.movement.pos.x - this.sentFeet.x;
    const sub = Number.isFinite(frac) && Math.abs(frac) < 2 ? frac : 0;
    this.anim.root.position.set(this.app.screen.width / 2 + sub, this.app.screen.height - FOOT_MARGIN * s);
    this.anim.update(dt, {
      state: m.state, time: m.time, progress: m.progress, clock: this.clock, facing: this.movement.facing,
      idleVariant: this.idleVariant, size: s, blinkClosed, swing: this.drag.swing, lagX: this.drag.lagX,
      lagY: this.drag.lagY, grabPoint: this.grabPoint, lean: this.lean, impact: this.impact,
      tail: this.drag.tail, stretch: this.drag.stretch, wiggle: this.drag.wiggle, wiggleX: this.drag.wiggleX,
      kick: this.drag.kick, act: this.drag.act, heldFor: this.drag.active ? this.drag.heldFor : 0,
      speed: this.movement.speedOf(m.state, speed),
    });
    this.effects.update(dt);

    // Breathing looks fine at 30 fps. Anything that moves follows the screen's own refresh rate (0 = every
    // frame): a fixed cap such as 60 on a 144/180 Hz screen lands on an uneven mix of frames and judders.
    const busy = MOTION_STATES.includes(m.state) || this.effects.active || this.anim.fading || this.anim.offsetMagnitude > 0.5;
    const fps = busy ? 0 : 30;
    if (this.app.ticker.maxFPS !== fps) this.app.ticker.maxFPS = fps;
  }

  private sendPosition(): void {
    if (this.drag.active) return;
    const x = Math.round(this.movement.pos.x), y = Math.round(this.movement.pos.y);
    if (x === this.sentFeet.x && y === this.sentFeet.y) return;
    this.sentFeet = { x, y };
    this.api.moveTo({ x, y });
  }

  // ------------------------------------------------------------------ state reactions
  private showStatePose(state: PetState): void {
    const key = state === 'run' && this.movement.facing === 'right' ? 'run:right' : state;
    let pose: Pose;
    if (this.poseOverride && this.sprites.has(this.poseOverride)) pose = this.sprites.pose(this.poseOverride);
    else pose = pick(this.sprites.posesFor(key));
    this.poseOverride = null;
    // Keep the mouth as it was: coming back to the standing picture must not pop it open.
    if (this.mouthShut && pose.name === this.sprites.mouthOpen) pose = this.sprites.pose(this.sprites.mouthClosed);
    this.anim.setPose(pose);
  }

  /**
   * The standing picture exists with the mouth open and closed (identical otherwise). At rest she switches
   * now and then, staying closed a little longer than open; while talking the mouth opens and closes quickly.
   */
  private updateMouth(dt: number): void {
    const { mouthOpen, mouthClosed } = this.sprites;
    if (!mouthOpen) return;
    const shown = this.anim.currentPose.name;
    if (shown !== mouthOpen && shown !== mouthClosed) return;
    const talking = this.machine.state === 'talking';
    if (talking && this.mouthTimer > 0.3) this.mouthTimer = 0.1;          // start speaking right away
    this.mouthTimer -= dt;
    if (this.mouthTimer > 0) return;
    this.mouthShut = !this.mouthShut;
    this.mouthTimer = talking ? 0.11 + Math.random() * 0.16 : this.mouthShut ? 3 + Math.random() * 6 : 2 + Math.random() * 3.5;
    this.anim.setPose(this.sprites.pose(this.mouthShut ? mouthClosed : mouthOpen), talking);
  }

  private onTransition(next: PetState, prev: PetState): void {
    if (next === 'idle' && prev === 'landing' && this.afterLanding) {
      const follow = this.afterLanding;
      this.afterLanding = null;
      this.machine.force(follow);
      return;
    }
    this.showStatePose(next);
    this.hooks.onState(next);
    if (next !== 'idle') { this.idleVariant = 'none'; this.variantLeft = 0; }
    if (next === 'turnLeft') this.movement.facing = 'left';
    if (next === 'turnRight') this.movement.facing = 'right';
    if (next === 'angry') { this.spawn('anger', 30, 24); this.hooks.say(pick(LINES.grab3)); }
    if (next === 'waking') { this.hooks.say(pick(LINES.wake)); this.api.petEvent('woke'); }
    if (next === 'sleeping') { this.effectTimer = 0.6; this.api.petEvent('slept'); }
    if (next === 'jump') this.sound.play('jump');
    if (SCENE_STATES.includes(next)) {
      // Play the drawn sequence a random number of whole times (1–3 bites), never stopping mid-way.
      // The animation runs on real time, the state timer on time scaled by the speed setting.
      const seq = this.sprites.sequence(next);
      if (seq) this.machine.setDuration((seq.frames.length / seq.fps) * (1 + Math.floor(Math.random() * 3)) * this.settings.speed);
      else this.machine.force('idle');
    }
    if (!this.machine.isDragging() && next !== 'falling') this.grabPoint = null;
  }

  /** While held: the drag controller decides what she does; here it becomes pictures, bubbles and effects. */
  private onDragEvent(ev: DragEvent): void {
    const m = this.machine;
    switch (ev) {
      case 'struggle':
        if (m.state !== 'dragStart') m.force('struggling');
        this.holdSay(LINES.holdStruggle, 0.4, 1400);
        break;
      case 'calm':
        if (m.state === 'struggling') m.force('dragging');
        this.showHoldPose();
        break;
      case 'act':
        this.showHoldPose();
        if (this.drag.act === 'peek') this.holdSay(LINES.holdLook, 0.3, 1500);
        break;
      case 'dizzy':
        for (let i = 0; i < 4; i++) this.spawn('star', (Math.random() - 0.5) * 70, 6);
        this.showHoldPose();
        this.holdSay(LINES.holdDizzy, 1, 1800);
        break;
      case 'whee':
        this.spawn('exclaim', 0, 0);
        this.holdSay(LINES.holdFast, 0.8, 1300);
        break;
      case 'tired':
        this.spawn('sweat', 30, 20);
        this.holdSay(LINES.holdTired, 1, 2200);
        break;
    }
  }

  /** Speech while held, rate-limited so the bubble does not flicker. */
  private holdSay(lines: readonly string[], chance: number, ms: number): void {
    if (this.clock < this.holdSayAt || Math.random() > chance) return;
    this.holdSayAt = this.clock + ms / 1000 + 1.5;
    this.hooks.say(pick(lines), ms);
  }

  /**
   * Optional extra held pictures: when the character has `hang-kick`, `hang-look`, `hang-tired` or `dizzy`,
   * they are shown for the matching moment; otherwise the normal hanging picture stays.
   */
  private showHoldPose(): void {
    if (this.machine.state !== 'dragging') return;
    const extra = this.drag.act === 'kick' ? 'hang-kick' : this.drag.act === 'peek' ? 'hang-look' : this.drag.act === 'limp' ? (this.drag.tired > 0.6 ? 'hang-tired' : 'dizzy') : '';
    this.anim.setPose(extra && this.sprites.has(extra) ? this.sprites.pose(extra) : pick(this.sprites.posesFor('dragging')));
  }

  private onLanded(speed: number): void {
    this.impact = Math.min(1, speed / 1800);
    this.machine.force('landing');
    this.sound.play('land');
    if (speed > TUNING.hardLanding) {
      for (let i = 0; i < 3; i++) this.spawn('star', (Math.random() - 0.5) * 60, 10);
      if (this.emotion.annoyance < 3) this.hooks.say(pick(LINES.landHard), 1500);
    }
  }

  private spawn(kind: EffectKind, dx: number, dy: number): void {
    const top = this.anim.headTop();
    this.effects.spawn(kind, top.x + dx * this.settings.size, top.y + dy * this.settings.size, 0.55 + 0.6 * this.settings.size);
  }

  /** Menu / AI actions. `fromUser` lets a menu click override a sulk; the AI cannot. */
  perform(action: PetAction, fromUser = false): void {
    const m = this.machine;
    if (m.state === 'sleeping' && action !== 'sleep') { if (!m.request('waking')) return; if (!fromUser) return; }
    if (this.emotion.isAngry() && !fromUser && action !== 'angry') return;
    switch (action) {
      case 'wave': this.poseOverride = 'wave'; if (!m.request('happy')) this.poseOverride = null; break;
      case 'happy': m.request('happy'); break;
      case 'jump': m.request('jump'); break;
      case 'wink': m.request('blink'); break;
      case 'shy': m.request('shy'); break;
      case 'angry': m.request('angry'); break;
      case 'lookAround': m.request('lookAround'); break;
      case 'eat':
        // Only characters drawn eating can do it; the others are just pleased at the idea.
        if (!this.scenes.includes('eating')) m.request('happy');
        else if (fromUser && !m.isDragging() && m.state !== 'falling' && m.state !== 'eating') m.force('eating');
        else m.request('eating');
        break;
      case 'sleep':
        if (fromUser && !m.isDragging() && m.state !== 'falling') m.force('sleeping');
        else m.request('sleeping');
        break;
      case 'none': break;
    }
  }

  private onChatEvent(meta: PetNotice): void {
    const m = this.machine;
    if ('agent' in meta) {
      // Agent progress: transient reactions only. The final emotion/action arrives with the reply.
      switch (meta.agent) {
        case 'thinking': m.request('talking'); this.spawn('question', 26, 22); break;
        case 'working':
          m.request('talking');
          if (meta.text) this.hooks.say(meta.text.length > 22 ? `${meta.text.slice(0, 21)}…` : meta.text, 2600);
          this.spawn('sweat', 30, 20);
          break;
        case 'asking': m.request('talking'); this.spawn('question', 26, 22); this.hooks.say(meta.text ?? '需要你确认一下～', 4000); break;
        case 'success': this.spawn('star', 0, 10); break;
        case 'failure': this.spawn('sweat', 30, 20); if (meta.text) this.hooks.say(meta.text, 2600); if (m.state === 'talking') m.force('idle'); break;
        case 'idle': if (m.state === 'talking') m.force('idle'); break;
      }
      return;
    }
    if ('talking' in meta) {
      if (meta.talking) m.request('talking');
      else if (m.state === 'talking') m.force('idle');
      return;
    }
    if (m.state === 'talking') m.force('idle');
    this.emotion.onChat(meta.emotion);
    const reaction: Partial<Record<Emotion, PetAction>> = { happy: 'happy', shy: 'shy', angry: 'angry', sleepy: 'none', surprised: 'lookAround' };
    this.perform(meta.action !== 'none' ? meta.action : reaction[meta.emotion] ?? 'none');
    if (meta.reply) this.hooks.say(meta.reply.length > 26 ? `${meta.reply.slice(0, 25)}…` : meta.reply, 3200);
  }

  private onStatsChanged(stats: InitialData['stats']): void {
    this.hooks.onStats(stats);
    if (this.statsTimer !== null) return;
    this.statsTimer = window.setTimeout(() => { this.statsTimer = null; this.api.saveStats(this.emotion.stats); }, 2500);
  }

  private applySettings(s: Settings): void {
    this.settings = s;
    this.movement.size = s.size;
    this.movement.gravity = s.gravity;
    this.sound.enabled = s.sound;
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.app.ticker.start();
    else { this.interaction?.cancel(); this.app.ticker.stop(); }
  }

  // ------------------------------------------------------------------ InteractionHost
  hitTest(x: number, y: number): { hit: boolean; head: boolean } {
    return this.anim ? this.anim.hitTest(x, y) : { hit: false, head: false };
  }
  canDrag(): boolean { return this.settings.allowDrag; }
  setIgnoreMouse(ignore: boolean): void { this.api.setIgnoreMouse(ignore); }

  onGrab(x: number, y: number): boolean {
    if (!this.machine.request('dragStart')) return false;
    const level = this.emotion.onGrab();
    this.grabPoint = { x: x - this.anim.root.x, y: y - this.anim.root.y };
    this.drag.begin();
    this.api.dragStart();
    this.sound.play('grab');
    this.afterLanding = level >= 3 ? 'angry' : null;
    if (level === 1) { this.spawn('exclaim', 0, 0); this.hooks.say(pick(LINES.grab1), 1200); }
    else if (level === 2) { this.spawn('sweat', 30, 20); this.hooks.say(pick(LINES.grab2), 1600); }
    else { this.spawn('anger', 30, 24); this.hooks.say(pick(LINES.grab3), 1600); }
    return true;
  }

  onRelease(): void {
    const vx = this.drag.end();
    this.api.dragEnd();
    if (this.movement.isAirborne()) {
      this.movement.startFall(vx * 0.25);
      this.machine.force('falling');
    } else {
      this.machine.force('landing');          // gravity off (or already on the floor): she is simply set down here
    }
  }

  onClick(part: 'head' | 'body'): void {
    const m = this.machine;
    this.emotion.onClick();
    this.api.petEvent('clicked');
    this.sound.play('pop');
    if (m.state === 'sleeping') { m.request('waking'); return; }
    if (this.emotion.isAngry()) { this.spawn('anger', 30, 24); this.hooks.say(pick(LINES.angryIgnore), 1400); return; }
    if (part === 'head') {
      const roll = Math.random();
      if (roll < 0.34) m.request('happy');
      else if (roll < 0.67) m.request('blink');
      else m.request('lookAround');
    } else if (this.emotion.stats.mood === 'happy') {
      if (m.request('happy')) this.hooks.say(pick(LINES.clickHappy), 1500);
    } else if (m.request('lookAround')) {
      this.spawn('question', 34, 10);
      this.hooks.say(pick(LINES.clickBody), 1500);
    }
  }

  onDoubleClick(): void {
    this.emotion.onClick();
    if (this.machine.state === 'sleeping') this.machine.request('waking');
    else { this.poseOverride = 'jump'; if (this.machine.request('jump')) this.spawn('heart', 0, 0); else this.poseOverride = null; }
    this.api.openChat();
  }

  onPet(direction: number): void {
    const m = this.machine;
    if (m.state === 'sleeping' || this.emotion.isAngry() && this.emotion.annoyance >= 3) {
      if (m.state !== 'sleeping') this.emotion.onPet();       // petting slowly calms her down
      return;
    }
    if (m.request('petting')) {
      m.extend(0.9);
      this.emotion.onPet();
      if (m.time < 0.05) this.api.petEvent('petted');
      this.leanTarget = direction >= 0 ? 1 : -1;
      if (m.time < 0.05) { this.sound.play('pet'); if (Math.random() < 0.5) this.hooks.say(pick(LINES.pet), 1500); }
    }
  }

  onHover(x: number | null): void {
    if (this.machine.state === 'petting') return;
    this.leanTarget = x === null ? 0 : Math.max(-1, Math.min(1, (x - this.anim.root.x) / (60 * this.settings.size)));
  }

  onContextMenu(): void { this.api.showContextMenu(); }

  // ------------------------------------------------------------------ teardown
  destroy(): void {
    this.destroyed = true;
    for (const fn of this.unsubscribe) fn();
    this.unsubscribe.length = 0;
    this.interaction?.destroy();
    this.interaction = null;
    if (this.statsTimer !== null) { window.clearTimeout(this.statsTimer); this.api.saveStats(this.emotion.stats); }
    this.sound.destroy();
    try {
      this.effects.destroy();
      this.anim?.destroy();
      this.sprites.destroy();
      this.app.destroy(false, { children: true });
    } catch { /* already torn down */ }
  }
}

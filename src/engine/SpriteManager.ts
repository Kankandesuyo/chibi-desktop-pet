import { Texture } from 'pixi.js';
import type { PetState } from '../../shared/types';
import type { CharacterId } from '../../shared/characters';
import { CHARACTER_ART } from '../config/characters';
import { DEFAULT_STATE_POSES } from '../config/petConfig';

/** Every PNG in assets/characters (and one folder per extra character) is picked up at build time. */
const FILE_URLS = import.meta.glob<string>('../../assets/characters/**/*.png', { eager: true, import: 'default', query: '?url' });
const ROOT = '../../assets/characters/';

export interface Pose {
  name: string;
  texture: Texture;
  /** x, y, width, height of the character inside the shared canvas (texture pixels). */
  bounds: [number, number, number, number];
  /** Point she hangs from while held (texture pixels). Defaults to the top of the head. */
  grab: [number, number];
  /** True when the art was drawn to hang from `grab` (a real "held" picture). Otherwise she pivots where she was grabbed. */
  hangs: boolean;
  cheeks: [number, number][];
  /** Low-resolution alpha map for per-pixel hit testing. */
  mask: Uint8Array;
  maskW: number;
  maskH: number;
  /** True when the real file was missing and a stand-in is shown. */
  placeholder: boolean;
  /** Row (texture px) where the skirt ends; below it only boots. Used to keep the feet planted while the skirt sways. */
  hem: number;
  /** Side views split into body + leg so the legs can swing when walking. */
  rig: PoseRig | null;
}

export interface PoseRig {
  body: Texture;
  leg: Texture;
  /** Top-left of the leg picture in the shared canvas. */
  origin: [number, number];
  /** Pivot the leg swings around (canvas px), hidden under the skirt. */
  hip: [number, number];
}

export interface CanvasSpec { width: number; height: number; anchor: [number, number]; standHeight: number }

const MASK_STEP = 4;
type StateKey = PetState | 'run:right';

function isPoint(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}
function isBounds(v: unknown): v is [number, number, number, number] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cannot load ${url}`));
    img.src = url;
  });
}

/** Loads the manifest + pictures, normalises them to one canvas/anchor, and answers "which picture now?". */
export class SpriteManager {
  readonly canvas: CanvasSpec;
  readonly warnings: string[] = [];
  private poses = new Map<string, Pose>();
  private statePoses: Record<string, string[]> = { ...DEFAULT_STATE_POSES };
  private sequences = new Map<string, { frames: string[]; fps: number; mirrored: boolean; stepLength: number; stepsPerCycle: number; blend: boolean }>();
  /** Manifest `walkSpeedScale`: how fast this character walks compared with the default. */
  readonly walkSpeedScale: number;
  private readonly manifest: Record<string, unknown>;
  /** Folder prefix of this character's pictures, e.g. '../../assets/characters/deepseek/'. */
  private readonly prefix: string;
  /** States that have no art of their own for this character (shown with procedural motion). */
  readonly missing: string[];
  private fallbackName = 'idle';
  blinkBase = 'idle';
  blinkClosed = 'blink';
  /** Further "open eyes -> closed eyes" pairs (e.g. the closed-mouth idle has its own blink frame). */
  private blinkPairs = new Map<string, string>();
  /** Idle picture with the mouth open / closed; '' when the character has no closed-mouth picture. */
  mouthOpen = '';
  mouthClosed = '';

  constructor(readonly character: CharacterId = 'orange') {
    const art = CHARACTER_ART[character] ?? CHARACTER_ART.orange;
    this.manifest = art.manifest;
    this.prefix = art.dir ? `${ROOT}${art.dir}/` : ROOT;
    const m = this.manifest;
    this.walkSpeedScale = typeof m.walkSpeedScale === 'number' && m.walkSpeedScale > 0 ? Math.min(3, Math.max(0.3, m.walkSpeedScale)) : 1;
    this.missing = Array.isArray(m.missing) ? (m.missing as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const c = (m.canvas ?? {}) as Record<string, unknown>;
    this.canvas = {
      width: typeof c.width === 'number' ? c.width : 640,
      height: typeof c.height === 'number' ? c.height : 580,
      anchor: isPoint(c.anchor) ? c.anchor : [320, 552],
      standHeight: typeof c.standHeight === 'number' ? c.standHeight : 440,
    };
  }

  async load(): Promise<void> {
    const m = this.manifest;
    if (typeof m.fallback === 'string') this.fallbackName = m.fallback;
    if (m.blink === null) {
      this.blinkClosed = '';                       // no closed-eyes picture: blinking is off, nothing is faked
    } else {
      const blink = (m.blink ?? {}) as Record<string, unknown>;
      if (typeof blink.base === 'string') this.blinkBase = blink.base;
      if (typeof blink.closed === 'string') this.blinkClosed = blink.closed;
      for (const [open, shut] of Object.entries((blink.pairs ?? {}) as Record<string, unknown>)) {
        if (typeof shut === 'string') this.blinkPairs.set(open, shut);
      }
    }

    const urlByFile = new Map<string, string>();
    for (const [path, url] of Object.entries(FILE_URLS)) {
      const rest = path.startsWith(this.prefix) ? path.slice(this.prefix.length) : null;
      if (rest && !rest.includes('/')) urlByFile.set(rest, url);            // this character's own folder only
    }

    const declared = (m.poses ?? {}) as Record<string, Record<string, unknown>>;
    const jobs: Promise<void>[] = [];
    const used = new Set<string>();
    for (const [name, spec] of Object.entries(declared)) {
      const file = typeof spec.file === 'string' ? spec.file : `${name}.png`;
      used.add(file);
      jobs.push(this.loadPose(name, urlByFile.get(file), spec, file));
    }
    // Pictures that are in the folder but not in the manifest still become usable poses.
    const parts = new Set(Array.isArray(m.parts) ? (m.parts as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    for (const [file, url] of urlByFile) {
      if (!used.has(file) && !parts.has(file)) jobs.push(this.loadPose(file.replace(/\.png$/i, ''), url, {}, file));
    }
    await Promise.all(jobs);

    for (const [key, raw] of Object.entries((m.sequences ?? {}) as Record<string, unknown>)) {
      const s = (raw ?? {}) as { frames?: unknown; fps?: unknown; frameDurationMs?: unknown; approximateMirroring?: unknown; stepLength?: unknown; stepsPerCycle?: unknown; blend?: unknown };
      if (!Array.isArray(s.frames)) continue;
      const frames = s.frames.filter((n): n is string => typeof n === 'string' && this.poses.has(n));
      const fps = typeof s.fps === 'number' && s.fps > 0 ? s.fps
        : typeof s.frameDurationMs === 'number' && s.frameDurationMs > 0 ? 1000 / s.frameDurationMs : 8;
      const stepLength = typeof s.stepLength === 'number' && s.stepLength > 0 ? s.stepLength : 0;
      const stepsPerCycle = typeof s.stepsPerCycle === 'number' && s.stepsPerCycle > 0 ? s.stepsPerCycle : 2;
      if (frames.length >= 2) this.sequences.set(key, { frames, fps, mirrored: s.approximateMirroring === true, stepLength, stepsPerCycle, blend: s.blend === true });
      else this.warnings.push(`动作序列 ${key} 的帧不完整，改用单张图`);
    }
    const mouth = (m.mouth ?? {}) as Record<string, unknown>;
    if (typeof mouth.open === 'string' && typeof mouth.closed === 'string' && this.poses.has(mouth.open) && this.poses.has(mouth.closed)) {
      this.mouthOpen = mouth.open;
      this.mouthClosed = mouth.closed;
    }
    const states = (m.states ?? {}) as Record<string, unknown>;
    for (const [key, list] of Object.entries(states)) {
      if (Array.isArray(list) && list.every((n) => typeof n === 'string') && list.length > 0) this.statePoses[key] = list as string[];
    }
    if (!this.poses.has(this.fallbackName) || this.poses.get(this.fallbackName)?.placeholder) {
      const firstReal = [...this.poses.values()].find((p) => !p.placeholder);
      if (firstReal) this.fallbackName = firstReal.name;
      else this.poses.set(this.fallbackName, this.makePlaceholder(this.fallbackName));
    }
  }

  private async loadPose(name: string, url: string | undefined, spec: Record<string, unknown>, file: string): Promise<void> {
    if (!url) {
      this.warnings.push(`缺少素材 ${file}，已用默认图代替`);
      return;                                     // resolved to the fallback pose on lookup
    }
    try {
      const img = await loadImage(url);
      const { mask, maskW, maskH, opaqueCorners, box } = this.readAlpha(img);
      if (opaqueCorners >= 3) this.warnings.push(`素材 ${file} 的背景不是透明的（四角不透明），显示时会带底色`);
      if (img.naturalWidth !== this.canvas.width || img.naturalHeight !== this.canvas.height) {
        this.warnings.push(`素材 ${file} 的尺寸是 ${img.naturalWidth}×${img.naturalHeight}，不是统一画布 ${this.canvas.width}×${this.canvas.height}，位置可能有偏差`);
      }
      const bounds = isBounds(spec.bounds) ? spec.bounds : box;
      const grab: [number, number] = isPoint(spec.grab) ? spec.grab : [this.canvas.anchor[0], bounds[1] + bounds[3] * 0.12];
      const cheeks = Array.isArray(spec.cheeks) ? (spec.cheeks as unknown[]).filter(isPoint) : [];
      const hem = typeof spec.hem === 'number' ? spec.hem : bounds[1] + bounds[3] * 0.88;
      const rig = await this.loadRig(spec.rig, file);
      this.poses.set(name, { name, texture: Texture.from(img), bounds, grab, hangs: isPoint(spec.grab), cheeks, mask, maskW, maskH, placeholder: false, hem, rig });
    } catch {
      this.warnings.push(`素材 ${file} 加载失败，已用默认图代替`);
    }
  }

  private async loadRig(raw: unknown, file: string): Promise<PoseRig | null> {
    const r = (raw ?? null) as Record<string, unknown> | null;
    if (!r || typeof r.body !== 'string' || typeof r.leg !== 'string' || !isPoint(r.origin) || !isPoint(r.hip)) return null;
    const files = Object.fromEntries((await Promise.all([r.body, r.leg].map(async (f) => {
      const url = FILE_URLS[`${this.prefix}${f}`];
      return [f, url ? await loadImage(url).catch(() => null) : null] as const;
    }))));
    const body = files[r.body]; const leg = files[r.leg];
    if (!body || !leg) { this.warnings.push(`素材 ${file} 的走路分层图缺失，走路时腿不会摆动`); return null; }
    return { body: Texture.from(body), leg: Texture.from(leg), origin: r.origin, hip: r.hip };
  }

  private readAlpha(img: HTMLImageElement): { mask: Uint8Array; maskW: number; maskH: number; opaqueCorners: number; box: [number, number, number, number] } {
    const maskW = Math.ceil(img.naturalWidth / MASK_STEP);
    const maskH = Math.ceil(img.naturalHeight / MASK_STEP);
    const cv = document.createElement('canvas');
    cv.width = maskW;
    cv.height = maskH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const mask = new Uint8Array(maskW * maskH);
    if (!ctx) return { mask: mask.fill(255), maskW, maskH, opaqueCorners: 0, box: [0, 0, img.naturalWidth, img.naturalHeight] };
    ctx.drawImage(img, 0, 0, maskW, maskH);
    const data = ctx.getImageData(0, 0, maskW, maskH).data;
    let x0 = maskW, y0 = maskH, x1 = 0, y1 = 0;
    for (let i = 0; i < mask.length; i++) {
      const a = data[i * 4 + 3] as number;
      mask[i] = a;
      if (a > 40) {
        const x = i % maskW, y = Math.floor(i / maskW);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    const corner = (x: number, y: number): number => ((mask[y * maskW + x] as number) > 200 ? 1 : 0);
    const opaqueCorners = corner(0, 0) + corner(maskW - 1, 0) + corner(0, maskH - 1) + corner(maskW - 1, maskH - 1);
    const box: [number, number, number, number] = x1 >= x0
      ? [x0 * MASK_STEP, y0 * MASK_STEP, (x1 - x0 + 1) * MASK_STEP, (y1 - y0 + 1) * MASK_STEP]
      : [0, 0, img.naturalWidth, img.naturalHeight];
    return { mask, maskW, maskH, opaqueCorners, box };
  }

  /** A plain stand-in so the app still runs with an empty assets folder. */
  private makePlaceholder(name: string): Pose {
    const { width, height, anchor, standHeight } = this.canvas;
    const cv = document.createElement('canvas');
    cv.width = width;
    cv.height = height;
    const ctx = cv.getContext('2d');
    const w = standHeight * 0.55;
    const bounds: [number, number, number, number] = [anchor[0] - w / 2, anchor[1] - standHeight, w, standHeight];
    if (ctx) {
      ctx.fillStyle = '#f28a35';
      ctx.beginPath();
      ctx.roundRect(bounds[0], bounds[1], bounds[2], bounds[3], 60);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 40px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('?', anchor[0], anchor[1] - standHeight / 2);
    }
    const maskW = Math.ceil(width / MASK_STEP), maskH = Math.ceil(height / MASK_STEP);
    const mask = new Uint8Array(maskW * maskH);
    for (let y = 0; y < maskH; y++) for (let x = 0; x < maskW; x++) {
      const px = x * MASK_STEP, py = y * MASK_STEP;
      if (px >= bounds[0] && px <= bounds[0] + bounds[2] && py >= bounds[1] && py <= bounds[1] + bounds[3]) mask[y * maskW + x] = 255;
    }
    return { name, texture: Texture.from(cv), bounds, grab: [anchor[0], bounds[1] + 30], hangs: false, cheeks: [], mask, maskW, maskH, placeholder: true, hem: bounds[1] + bounds[3], rig: null };
  }

  get poseNames(): string[] { return [...this.poses.keys()]; }

  /** Never throws and never returns undefined: unknown / missing poses resolve to the fallback. */
  pose(name: string): Pose {
    return this.poses.get(name) ?? (this.poses.get(this.fallbackName) as Pose);
  }

  has(name: string): boolean { return this.poses.has(name); }

  /** The closed-eyes twin of a picture (identical apart from the eyes), or null when it has none. */
  blinkFor(name: string): Pose | null {
    const shut = name === this.blinkBase ? this.blinkClosed : this.blinkPairs.get(name) ?? '';
    return shut && this.poses.has(shut) ? this.pose(shut) : null;
  }

  /** Frame-by-frame animation for a state key ("walkLeft", "run:left"…), if the art exists. */
  /**
   * `stepLength` (canvas px one step covers, 0 = unknown) lets the legs keep time with the ground;
   * `stepsPerCycle` says how many steps the frames show (2 = a full left-right cycle, 1 = one step that loops);
   * `blend` asks for each frame to dissolve into the next (for frames drawn close together).
   */
  sequence(key: string): { frames: Pose[]; fps: number; stepLength: number; stepsPerCycle: number; blend: boolean } | null {
    const s = this.sequences.get(key);
    return s ? { frames: s.frames.map((n) => this.pose(n)), fps: s.fps, stepLength: s.stepLength, stepsPerCycle: s.stepsPerCycle, blend: s.blend } : null;
  }

  /** Sequences that are flipped copies standing in for art that has not been drawn yet. */
  get mirroredSequences(): string[] { return [...this.sequences].filter(([, s]) => s.mirrored).map(([k]) => k); }

  /** Candidate pictures for a state (existing ones only; the fallback if none exist). */
  posesFor(key: StateKey): Pose[] {
    const names = (this.statePoses[key] ?? []).filter((n) => this.poses.has(n));
    return names.length > 0 ? names.map((n) => this.pose(n)) : [this.pose(this.fallbackName)];
  }

  /** Is this texture pixel part of the character? */
  hit(pose: Pose, tx: number, ty: number): boolean {
    const x = Math.floor(tx / MASK_STEP), y = Math.floor(ty / MASK_STEP);
    if (x < 0 || y < 0 || x >= pose.maskW || y >= pose.maskH) return false;
    return (pose.mask[y * pose.maskW + x] as number) > 40;
  }

  /** Top ~half of the character counts as "head" for petting. */
  isHead(pose: Pose, tx: number, ty: number): boolean {
    const [bx, by, bw, bh] = pose.bounds;
    return tx >= bx && tx <= bx + bw && ty >= by && ty <= by + bh * 0.5;
  }

  destroy(): void {
    for (const p of this.poses.values()) p.texture.destroy(true);
    this.poses.clear();
  }
}

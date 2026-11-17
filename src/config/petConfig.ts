import type { PetState } from '../../shared/types';

/** Tunable numbers in one place. Distances are DIP at size = 1 unless noted. */
export const TUNING = {
  walkSpeed: 58,
  runSpeed: 150,
  gravity: 2400,
  maxFallSpeed: 2200,
  /** A landing faster than this (px/s) gets the dizzy stars. */
  hardLanding: 900,
  jumpHeight: 46,
  dragHoldMs: 170,
  dragMovePx: 5,
  doubleClickMs: 260,
  /** Held about this long (s, rolled ±30 %) before the first struggle; later ones come at random. */
  struggleAfter: 2.6,
  /** Grab counter: one step is forgiven every N seconds. */
  annoyanceCooldown: 18,
  petDistance: 90,
  petWindowMs: 1400,
  crossfadeMs: 140,
  blinkMs: 115,
  /** Seconds without any interaction before she may fall asleep on her own. */
  sleepAfterIdle: 150,
  /** Minimum gap between two autonomous actions (s). */
  minAutoGap: 3.5,
} as const;

/**
 * Default "which picture for which state". assets/characters/manifest.json may override any entry
 * under "states". `run:right` exists because there is no run-right picture and mirroring would put
 * the hair flower on the wrong side.
 */
export const DEFAULT_STATE_POSES: Record<PetState | 'run:right', string[]> = {
  idle: ['idle'],
  blink: ['wink'],
  lookAround: ['idle'],
  walkLeft: ['left'],
  walkRight: ['right'],
  run: ['run-left'],
  'run:right': ['right'],
  turnLeft: ['left'],
  turnRight: ['right'],
  jump: ['jump'],
  dragStart: ['struggle'],
  dragging: ['hang'],
  struggling: ['struggle'],
  falling: ['jump'],
  landing: ['idle'],
  petting: ['closed-smile'],
  happy: ['happy', 'wave', 'kick'],
  shy: ['closed-smile'],
  angry: ['back'],
  sleeping: ['closed-smile'],
  waking: ['idle'],
  talking: ['idle'],
  eating: ['idle'],
};

export const LINES = {
  greet: ['我在这儿～', '今天也要加油哦！', '嗨～'],
  clickBody: ['嗯？', '怎么啦？', '找我有事吗？'],
  clickHappy: ['嘿嘿～', '今天心情很好！'],
  pet: ['好舒服～', '嘿嘿嘿…', '再摸摸～'],
  grab1: ['哇！', '诶诶？'],
  grab2: ['又来…', '别老抓我啦…'],
  grab3: ['放我下来！', '生气了！'],
  angryIgnore: ['哼。', '不理你。'],
  landHard: ['晕乎乎…', '疼…'],
  wake: ['唔…醒了…', '早呀…'],
  sleepy: ['有点困了…'],
  holdStruggle: ['放开我啦～', '唔唔——！', '让我下去嘛…'],
  holdDizzy: ['别晃啦…晕…', '眼睛在转圈…', '天旋地转…'],
  holdFast: ['呜哇——慢点！', '太快啦！', '要飞出去了！'],
  holdTired: ['要拎到什么时候呀…', '…随你吧。', '手不酸吗…'],
  holdLook: ['要带我去哪儿？', '好高…', '嗯…？'],
} as const;

export function pick<T>(list: readonly T[], rng: () => number = Math.random): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))] as T;
}

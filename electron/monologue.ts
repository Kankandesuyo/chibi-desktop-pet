import { parseAiReply } from '../shared/aiProtocol';
import type { MonologueLevel } from '../shared/persona';
import type { AiReplyMeta } from '../shared/types';

/** Minutes between two spontaneous lines, [min, max], per frequency setting. */
export const MONOLOGUE_GAP_MIN: Record<Exclude<MonologueLevel, 'off'>, [number, number]> = {
  rare: [40, 75], normal: [15, 30], often: [6, 12],
};

export interface MonologueDeps {
  level(): MonologueLevel;
  /** AI enabled and a key configured. When false she uses offline lines. */
  aiReady(): boolean;
  /** Pet shown, no task running, no chat streaming, not being dragged. */
  canSpeak(): boolean;
  /** Seconds since the user last touched mouse/keyboard. */
  idleSeconds(): number;
  /** One completion with no tools; returns the raw model text. */
  generate(signal: AbortSignal): Promise<string>;
  deliver(meta: AiReplyMeta): void;
  remember(line: string): void;
  now?: () => number;
  random?: () => number;
}

const AWAY_SECONDS = 300;

function offlineLine(hour: number, r: number): AiReplyMeta {
  const pick = <T>(a: T[]): T => a[Math.floor(r * a.length) % a.length]!;
  if (hour >= 23 || hour < 5) return pick([
    { reply: '唔…这么晚了，主人也早点睡吧。', emotion: 'sleepy', action: 'sleep' },
    { reply: '夜里的屏幕好安静呀…', emotion: 'sleepy', action: 'none' },
  ] as AiReplyMeta[]);
  if (hour < 9) return pick([
    { reply: '早上好～今天的屏幕太阳也很亮！', emotion: 'happy', action: 'happy' },
    { reply: '刚醒，头发还乱乱的…', emotion: 'shy', action: 'shy' },
  ] as AiReplyMeta[]);
  return pick([
    { reply: '桌面上今天会出现什么新东西呢？', emotion: 'surprised', action: 'lookAround' },
    { reply: '哼哼，我今天也有好好待在这里哦。', emotion: 'happy', action: 'none' },
    { reply: '主人忙的时候，我就安静陪着。', emotion: 'neutral', action: 'none' },
    { reply: '鼠标邻居刚才是不是路过了？', emotion: 'surprised', action: 'lookAround' },
    { reply: '伸个懒腰～', emotion: 'happy', action: 'happy' },
  ] as AiReplyMeta[]);
}

/** Lets her say something on her own now and then. Call tick() about once a minute. */
export class Monologue {
  private nextAt = 0;
  private busy: AbortController | null = null;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly d: MonologueDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  private schedule(): void {
    const level = this.d.level();
    if (level === 'off') { this.nextAt = 0; return; }
    const [a, b] = MONOLOGUE_GAP_MIN[level];
    this.nextAt = this.now() + (a + (b - a) * this.random()) * 60_000;
  }

  /** Returns true when a line was delivered. */
  async tick(): Promise<boolean> {
    if (this.d.level() === 'off') { this.nextAt = 0; return false; }
    if (this.nextAt === 0) { this.schedule(); return false; }
    if (this.now() < this.nextAt || this.busy) return false;
    // Only talk when someone is around to hear it, and never over a task or a conversation.
    if (this.d.idleSeconds() >= AWAY_SECONDS || !this.d.canSpeak()) { this.nextAt = this.now() + 2 * 60_000; return false; }
    this.schedule();
    let meta: AiReplyMeta | null = null;
    if (this.d.aiReady()) {
      this.busy = new AbortController();
      const timer = setTimeout(() => this.busy?.abort(), 20_000);
      try {
        const parsed = parseAiReply(await this.d.generate(this.busy.signal));
        const line = parsed.reply.replace(/\s+/g, ' ').trim();
        if (line && line.length <= 40) meta = { ...parsed, reply: line };
      } catch { /* fall back below */ } finally {
        clearTimeout(timer);
        this.busy = null;
      }
    }
    meta ??= offlineLine(new Date(this.now()).getHours(), this.random());
    if (!this.d.canSpeak()) return false;          // something started while we were thinking
    this.d.deliver(meta);
    this.d.remember(meta.reply);
    return true;
  }

  stop(): void { this.busy?.abort(); }
}

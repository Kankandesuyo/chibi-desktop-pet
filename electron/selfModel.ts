import * as fs from 'node:fs';
import * as path from 'node:path';

/** Things that happen to her. Only these come from the renderer (whitelisted). */
export const SELF_EVENTS = ['petted', 'grabbed', 'clicked', 'chatted', 'slept', 'woke', 'taskDone', 'taskFailed', 'said'] as const;
export type SelfEvent = typeof SELF_EVENTS[number];

export function isSelfEvent(v: unknown): v is SelfEvent {
  return typeof v === 'string' && (SELF_EVENTS as readonly string[]).includes(v);
}

type Counters = Record<'petted' | 'grabbed' | 'clicked' | 'chatted' | 'taskDone' | 'taskFailed', number>;
const ZERO: Counters = { petted: 0, grabbed: 0, clicked: 0, chatted: 0, taskDone: 0, taskFailed: 0 };

interface Recent { t: number; text: string }
interface SelfData {
  bornAt: number;
  totals: Counters;
  day: string;
  today: Counters;
  /** Notable moments (finished tasks, naps) — short, no user content. */
  recent: Recent[];
  /** Her own last spontaneous lines, so she does not repeat herself. */
  said: string[];
  lastSleepAt: number;
}

const MAX_RECENT = 20;
const MAX_SAID = 8;

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function counters(v: unknown): Counters {
  const o = (v ?? {}) as Record<string, unknown>;
  const out = { ...ZERO };
  for (const k of Object.keys(ZERO) as (keyof Counters)[]) {
    const n = o[k];
    out[k] = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  return out;
}

/** Her sense of self: how long she has lived here and what happened to her. Stored in self.json. */
export class SelfModel {
  private data: SelfData;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.data = this.load();
  }

  private load(): SelfData {
    const t = this.now();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const bornAt = typeof raw.bornAt === 'number' && raw.bornAt > 0 && raw.bornAt <= t ? raw.bornAt : t;
      return {
        bornAt,
        totals: counters(raw.totals),
        day: typeof raw.day === 'string' ? raw.day : dayKey(t),
        today: counters(raw.today),
        recent: Array.isArray(raw.recent)
          ? (raw.recent as Recent[]).filter((r) => r && typeof r.t === 'number' && typeof r.text === 'string').slice(-MAX_RECENT)
          : [],
        said: Array.isArray(raw.said) ? (raw.said as unknown[]).filter((s): s is string => typeof s === 'string').slice(-MAX_SAID) : [],
        lastSleepAt: typeof raw.lastSleepAt === 'number' ? raw.lastSleepAt : 0,
      };
    } catch {
      return { bornAt: t, totals: { ...ZERO }, day: dayKey(t), today: { ...ZERO }, recent: [], said: [], lastSleepAt: 0 };
    }
  }

  private rollDay(): void {
    const k = dayKey(this.now());
    if (k !== this.data.day) { this.data.day = k; this.data.today = { ...ZERO }; }
  }

  record(event: SelfEvent, detail = ''): void {
    this.rollDay();
    const t = this.now();
    const note = (text: string): void => { this.data.recent.push({ t, text: text.slice(0, 60) }); this.data.recent = this.data.recent.slice(-MAX_RECENT); };
    switch (event) {
      case 'said':
        if (detail) { this.data.said.push(detail.slice(0, 40)); this.data.said = this.data.said.slice(-MAX_SAID); }
        break;
      case 'slept': this.data.lastSleepAt = t; note('打了个盹'); break;
      case 'woke': if (this.data.lastSleepAt && t - this.data.lastSleepAt > 60_000) note('睡醒了'); break;
      case 'taskDone': this.bump(event); note(detail ? `帮主人完成了：${detail}` : '帮主人完成了一件事'); break;
      case 'taskFailed': this.bump(event); note(detail ? `没能完成：${detail}` : '有件事没能做成'); break;
      default: this.bump(event);
    }
    this.scheduleSave();
  }

  private bump(k: keyof Counters): void { this.data.totals[k] += 1; this.data.today[k] += 1; }

  ageDays(): number { return Math.floor((this.now() - this.data.bornAt) / 86_400_000); }
  today(): Counters { this.rollDay(); return { ...this.data.today }; }
  recentSaid(): string[] { return [...this.data.said]; }

  /** A few short lines describing her inner state, for the prompt. Contains no user file contents. */
  summary(): string {
    this.rollDay();
    const t = this.now();
    const d = this.data.today;
    const age = this.ageDays();
    const hour = new Date(t).getHours();
    const part = hour < 5 ? '深夜' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
    const lines = [
      `- 你来到这台电脑已经 ${age === 0 ? '不到一天（今天是你的第一天！）' : `${age} 天`}；现在是${part}。`,
      `- 今天：被摸头 ${d.petted} 次，被拎起来 ${d.grabbed} 次，被戳 ${d.clicked} 次，和主人聊天 ${d.chatted} 次，帮主人做成 ${d.taskDone} 件事${d.taskFailed ? `、失败 ${d.taskFailed} 件` : ''}。`,
      `- 一共：被摸头 ${this.data.totals.petted} 次，做成 ${this.data.totals.taskDone} 件事。`,
    ];
    const recent = this.data.recent.filter((r) => t - r.t < 3 * 86_400_000).slice(-5);
    if (recent.length) lines.push(`- 最近的事：${recent.map((r) => r.text).join('；')}`);
    if (this.data.said.length) lines.push(`- 你最近自言自语过：${this.data.said.slice(-4).map((s) => `“${s}”`).join(' ')}`);
    return lines.join('\n');
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 1500);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* best effort */ }
  }
}

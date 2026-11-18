import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScheduleInfo, ScheduleTrigger } from '../../shared/agentTypes';

/**
 * Scheduled and proactive tasks (harness phase 4). A task is a request she runs by herself when its
 * trigger fires: every day at a time, every N minutes, once at a time, or when a folder holds too many
 * files. Runs are unattended and read-only (see RunOptions): she looks and reports; anything that would
 * change the computer or needs a confirmation is left for the user. Stored in <agent data>/schedules.json.
 */

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  trigger: ScheduleTrigger;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
  /** Folder trigger: fires once when the count reaches the limit, then waits for it to drop again. */
  armed?: boolean;
}

const MAX_TASKS = 30;
const MIN_INTERVAL_MINUTES = 15;
/** A daily task missed while the app was closed still runs if the app starts within this long after. */
const CATCH_UP_MS = 6 * 3600_000;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export class Scheduler {
  private tasks: ScheduledTask[] = [];

  constructor(readonly file: string, private readonly countFiles: (dir: string) => number | null = defaultCount) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(raw)) this.tasks = raw.filter((t): t is ScheduledTask => !!t && typeof (t as ScheduledTask).id === 'string' && typeof (t as ScheduledTask).prompt === 'string').slice(0, MAX_TASKS);
    } catch { /* none yet */ }
  }

  list(): ScheduledTask[] { return this.tasks.map((t) => ({ ...t })); }
  get(id: string): ScheduledTask | null { const t = this.tasks.find((x) => x.id === id); return t ? { ...t } : null; }

  /** Validates and adds a task (throws a readable error). */
  add(input: { name: string; prompt: string; trigger: Partial<ScheduleTrigger> & { kind?: string } }, now = new Date()): ScheduledTask {
    if (this.tasks.length >= MAX_TASKS) throw new Error(`最多 ${MAX_TASKS} 个定时任务，先删掉一些`);
    const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 40);
    const prompt = input.prompt.trim().slice(0, 2000);
    if (!name) throw new Error('需要给定时任务起个名字');
    if (!prompt) throw new Error('需要写清楚到时候要做什么');
    const trigger = normalizeTrigger(input.trigger, now);
    const task: ScheduledTask = { id: `s${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name, prompt, trigger, enabled: true, createdAt: now.toISOString(), ...(trigger.kind === 'folder' ? { armed: true } : {}) };
    this.tasks.push(task);
    this.save();
    return { ...task };
  }

  remove(id: string): boolean {
    const n = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === n) return false;
    this.save();
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return false;
    t.enabled = enabled;
    if (enabled && t.trigger.kind === 'folder') t.armed = true;
    this.save();
    return true;
  }

  /** Tasks whose trigger has fired at `now` (also re-arms folder triggers whose folder emptied). */
  due(now = new Date()): ScheduledTask[] {
    const out: ScheduledTask[] = [];
    let changed = false;
    for (const t of this.tasks) {
      if (!t.enabled) continue;
      const tr = t.trigger;
      const last = t.lastRunAt ? Date.parse(t.lastRunAt) : null;
      if (tr.kind === 'daily') {
        const target = dailyTarget(tr.time, now).getTime();
        if (now.getTime() >= target && now.getTime() - target < CATCH_UP_MS && (last === null || last < target)) out.push(t);
      } else if (tr.kind === 'interval') {
        const from = last ?? Date.parse(t.createdAt);
        if (now.getTime() - from >= tr.minutes * 60_000) out.push(t);
      } else if (tr.kind === 'once') {
        if (last === null && now.getTime() >= Date.parse(tr.at)) out.push(t);
      } else if (tr.kind === 'folder') {
        const count = this.countFiles(tr.path);
        if (count === null) continue;
        if (count < tr.minFiles && t.armed === false) { t.armed = true; changed = true; }
        if (count >= tr.minFiles && t.armed !== false) out.push(t);
      }
    }
    if (changed) this.save();
    return out.map((t) => ({ ...t }));
  }

  /** Records that a task was started (a one-off task switches itself off, a folder trigger disarms). */
  markRun(id: string, now = new Date()): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.lastRunAt = now.toISOString();
    if (t.trigger.kind === 'once') t.enabled = false;
    if (t.trigger.kind === 'folder') t.armed = false;
    this.save();
  }

  recordResult(id: string, text: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.lastResult = clip(text.replace(/\s+/g, ' ').trim(), 300);
    this.save();
  }

  /** When it will run next (null for folder triggers and finished one-off tasks). */
  nextRun(t: ScheduledTask, now = new Date()): Date | null {
    if (!t.enabled) return null;
    const tr = t.trigger;
    if (tr.kind === 'daily') {
      const today = dailyTarget(tr.time, now);
      const last = t.lastRunAt ? Date.parse(t.lastRunAt) : null;
      return now.getTime() < today.getTime() || (last === null || last < today.getTime()) && now.getTime() - today.getTime() < CATCH_UP_MS ? today : new Date(today.getTime() + 86_400_000);
    }
    if (tr.kind === 'interval') return new Date((t.lastRunAt ? Date.parse(t.lastRunAt) : Date.parse(t.createdAt)) + tr.minutes * 60_000);
    if (tr.kind === 'once') return t.lastRunAt ? null : new Date(tr.at);
    return null;
  }

  info(now = new Date()): ScheduleInfo[] {
    return this.tasks.map((t) => {
      const next = this.nextRun(t, now);
      return {
        id: t.id, name: t.name, prompt: t.prompt, trigger: t.trigger, when: describeTrigger(t.trigger), enabled: t.enabled,
        ...(t.lastRunAt ? { lastRunAt: t.lastRunAt } : {}), ...(t.lastResult ? { lastResult: t.lastResult } : {}),
        ...(next ? { nextRunAt: next.toISOString() } : {}),
      };
    });
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.tasks, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error('[scheduler] save', err); }
  }
}

function dailyTarget(time: string, now: Date): Date {
  const m = TIME_RE.exec(time) ?? ['', '9', '00'];
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}

function normalizeTrigger(t: Partial<ScheduleTrigger> & { kind?: string }, now: Date): ScheduleTrigger {
  const r = t as Record<string, unknown>;
  switch (t.kind) {
    case 'daily': {
      const time = String(r.time ?? '').trim();
      if (!TIME_RE.test(time)) throw new Error('每天的时间要写成 09:00 这样的格式');
      const [h, m] = time.split(':');
      return { kind: 'daily', time: `${String(h).padStart(2, '0')}:${m}` };
    }
    case 'interval': {
      const minutes = Math.round(Number(r.minutes));
      if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > 7 * 24 * 60) throw new Error(`间隔要在 ${MIN_INTERVAL_MINUTES} 分钟到 7 天之间`);
      return { kind: 'interval', minutes };
    }
    case 'once': {
      const at = Date.parse(String(r.at ?? ''));
      if (!Number.isFinite(at)) throw new Error('一次性任务的时间要写成 ISO 格式，例如 2026-11-20T09:00:00');
      if (at < now.getTime() - 60_000) throw new Error('这个时间已经过去了');
      return { kind: 'once', at: new Date(at).toISOString() };
    }
    case 'folder': {
      const dir = String(r.path ?? '').trim();
      const minFiles = Math.round(Number(r.minFiles));
      if (!dir || !path.isAbsolute(dir)) throw new Error('需要文件夹的完整路径');
      if (!Number.isFinite(minFiles) || minFiles < 1 || minFiles > 100_000) throw new Error('文件数量要写一个正整数');
      return { kind: 'folder', path: dir, minFiles };
    }
    default:
      throw new Error('触发方式只能是 daily（每天）、interval（每隔一段时间）、once（一次）或 folder（文件夹文件太多时）');
  }
}

export function describeTrigger(t: ScheduleTrigger): string {
  switch (t.kind) {
    case 'daily': return `每天 ${t.time}`;
    case 'interval': return t.minutes % 60 === 0 ? `每 ${t.minutes / 60} 小时` : `每 ${t.minutes} 分钟`;
    case 'once': return `${new Date(t.at).toLocaleString('zh-CN', { hour12: false })}（一次）`;
    case 'folder': return `${t.path} 里超过 ${t.minFiles} 个文件时`;
  }
}

function defaultCount(dir: string): number | null {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length; } catch { return null; }
}

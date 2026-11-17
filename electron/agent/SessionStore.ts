import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionSummary, TurnStats } from '../../shared/harness';
import type { RecapStep, TaskRecap } from './TaskRecap';

/**
 * Event-sourced session log (after DeepSeek Harness's session model): everything that happens in a session
 * is appended to `sessions/<id>.jsonl` and nothing is ever rewritten.
 *
 * It is the single source of truth: the conversation shown in the desktop chat and the remote web page
 * (chat/message events), what the agent knows about earlier turns (turn/tool events), /resume, and the
 * trajectory view are all derived from it. Switching session switches all of them together.
 *
 * Everything written here is already redacted / clipped by the caller; the log is local to the user's
 * profile (inside the agent's protected data folder, which the agent itself cannot write to).
 */

export type TurnEndReason = 'completed' | 'aborted' | 'error' | 'max-steps' | 'interrupted';
export type TurnOutcome = TaskRecap['outcome'];

export type { TurnStats } from '../../shared/harness';

/** A message of the visible conversation (same shape the chat views already use). */
export interface ChatRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  time?: number | null;
  failed?: boolean;
  image?: unknown;
  steps?: unknown[];
  [key: string]: unknown;
}

export type SessionEvent =
  | { type: 'session/start' }
  | { type: 'chat/message'; message: ChatRecord }
  /** The old shared-history.json was copied into this session (done once). */
  | { type: 'chat/imported'; count: number }
  | { type: 'turn/start'; turnId: string; userText: string }
  | { type: 'step/start'; turnId: string; step: number }
  | { type: 'assistant/message'; turnId: string; text: string; calls: { id: string; name: string; args: string }[] }
  | { type: 'tool/result'; turnId: string; callId: string; name: string; result: RecapStep; ms?: number }
  | { type: 'compaction'; turnId: string; savedChars: number }
  | { type: 'turn/end'; turnId: string; reason: TurnEndReason; outcome: TurnOutcome; reply?: string; stats?: TurnStats };

export type LoggedEvent = SessionEvent & { seq: number; t: string };

/** One turn, rebuilt from the log. */
export interface TurnRecord {
  turnId: string;
  userText: string;
  steps: RecapStep[];
  reason: TurnEndReason | null;
  outcome: TurnOutcome | null;
  stats?: TurnStats;
}

export type { SessionSummary } from '../../shared/harness';

/** Above this a session file is closed and a new one started (keeps reads at startup cheap). */
const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const MAX_CHAT = 400;
const ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{2,8}$/;

export class SessionStore {
  private file = '';
  private seq = 0;
  private turnsCache: TurnRecord[] = [];
  private chatCache: ChatRecord[] = [];
  private imported = false;
  /** A turn the next request should pick up again (set by /resume). */
  private pendingResume: TurnRecord | null = null;
  private readonly switchListeners = new Set<() => void>();
  private readonly titleCache = new Map<string, { mtime: number; title: string }>();
  id = '';

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const latest = this.rememberedFile() ?? this.latestFile();
    if (latest && fs.statSync(latest).size < MAX_SESSION_BYTES) this.open(latest);
    else this.newSession();
  }

  /** Called whenever the current session changes (new, switched, rotated). */
  onSwitch(fn: () => void): () => void { this.switchListeners.add(fn); return () => { this.switchListeners.delete(fn); }; }

  private notifySwitch(): void { for (const fn of [...this.switchListeners]) { try { fn(); } catch (err) { console.error('[session] listener', err); } } }

  /** The session that was open when the app last ran (so a switched-to older session stays open). */
  private rememberedFile(): string | null {
    try {
      const id = fs.readFileSync(path.join(this.dir, 'current'), 'utf8').trim();
      const file = path.join(this.dir, `${id}.jsonl`);
      return ID_RE.test(id) && fs.existsSync(file) ? file : null;
    } catch { return null; }
  }

  private remember(): void {
    try { fs.writeFileSync(path.join(this.dir, 'current'), this.id, 'utf8'); } catch { /* only a convenience */ }
  }

  private latestFile(): string | null {
    let best: { f: string; m: number } | null = null;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const f = path.join(this.dir, name);
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best.m) best = { f, m };
    }
    return best?.f ?? null;
  }

  private open(file: string): void {
    this.file = file;
    this.id = path.basename(file, '.jsonl');
    const events = readEvents(file);
    this.seq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
    this.turnsCache = foldTurns(events);
    this.chatCache = foldChat(events);
    this.imported = events.some((e) => e.type === 'chat/imported');
    this.pendingResume = null;
    // Crash repair: a turn that never ended was cut off (the app quit or crashed mid-task).
    for (const t of this.turnsCache) {
      if (t.reason !== null) continue;
      this.append({ type: 'turn/end', turnId: t.turnId, reason: 'interrupted', outcome: 'cancelled' });
    }
  }

  newSession(): string {
    const d = new Date();
    const p2 = (n: number): string => String(n).padStart(2, '0');
    // Local time, so the file name matches the clock the user sees.
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    let id = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    while (fs.existsSync(path.join(this.dir, `${id}.jsonl`))) id = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    this.id = id;
    this.file = path.join(this.dir, `${id}.jsonl`);
    this.seq = 0;
    this.turnsCache = [];
    this.chatCache = [];
    this.imported = false;
    this.pendingResume = null;
    this.append({ type: 'session/start' });
    this.remember();
    this.notifySwitch();
    return id;
  }

  /** Opens another saved session. Returns false if it does not exist. */
  switchTo(id: string): boolean {
    if (!ID_RE.test(id)) return false;
    const file = path.join(this.dir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return false;
    if (id !== this.id) { this.open(file); this.remember(); this.notifySwitch(); }
    return true;
  }

  append(e: SessionEvent): void {
    const row: LoggedEvent = { ...e, seq: ++this.seq, t: new Date().toISOString() };
    try { fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, 'utf8'); } catch (err) { console.error('[session] append', err); }
    applyEvent(this.turnsCache, row);
    if (row.type === 'chat/message') this.chatCache = [...this.chatCache, row.message].slice(-MAX_CHAT);
    if (row.type === 'chat/imported') this.imported = true;
  }

  // ---- the visible conversation ----
  chat(): ChatRecord[] { return this.chatCache; }
  addChat(message: ChatRecord): void { this.append({ type: 'chat/message', message }); }
  /** One-time import of a conversation kept elsewhere before (shared-history.json). */
  importChat(messages: ChatRecord[]): void {
    if (this.imported || this.chatCache.length) return;
    for (const m of messages.slice(-MAX_CHAT)) this.append({ type: 'chat/message', message: m });
    this.append({ type: 'chat/imported', count: messages.length });
  }
  wasImported(): boolean { return this.imported; }

  // ---- turns ----
  turns(): TurnRecord[] { return this.turnsCache.map((t) => ({ ...t, steps: [...t.steps] })); }

  /** The last turn, if it did not finish its job (crash, stop, error or step limit). */
  lastUnfinished(): TurnRecord | null {
    const last = this.turnsCache[this.turnsCache.length - 1];
    return last && last.reason !== null && last.reason !== 'completed' ? { ...last, steps: [...last.steps] } : null;
  }

  setPendingResume(t: TurnRecord | null): void { this.pendingResume = t; }
  takePendingResume(): TurnRecord | null { const t = this.pendingResume; this.pendingResume = null; return t; }

  /** Raw events of the current session (for the trajectory view), newest last. */
  events(limit = 3000): LoggedEvent[] { return readEvents(this.file).slice(-limit); }

  info(): { id: string; file: string; turns: number; bytes: number } {
    let bytes = 0;
    try { bytes = fs.statSync(this.file).size; } catch { /* not written yet */ }
    return { id: this.id, file: this.file, turns: this.turnsCache.length, bytes };
  }

  /** All saved sessions, newest first. Titles are cached by file time, so this stays cheap. */
  list(limit = 200): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!ID_RE.test(id)) continue;
      const file = path.join(this.dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      let title = this.titleCache.get(id);
      if (!title || title.mtime !== mtime) { title = { mtime, title: firstUserText(file) }; this.titleCache.set(id, title); }
      out.push({ id, title: title.title, updatedAt: Math.round(mtime), current: id === this.id });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** Starts a new file when the current one has grown too big (called between turns). */
  rotateIfLarge(): void {
    if (this.info().bytes >= MAX_SESSION_BYTES) this.newSession();
  }
}

/** Title of a session: its first user message (read from the start of the file only). */
function firstUserText(file: string): string {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(64 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0); head = buf.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return '新会话'; }
  for (const line of head.split('\n')) {
    try {
      const e = JSON.parse(line) as LoggedEvent;
      const text = e.type === 'chat/message' && e.message.role === 'user' ? e.message.content : e.type === 'turn/start' ? e.userText : '';
      if (text.trim()) { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 40 ? `${t.slice(0, 40)}…` : t; }
    } catch { /* partial last line of the 64 KB window */ }
  }
  return '新会话';
}

function readEvents(file: string): LoggedEvent[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: LoggedEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LoggedEvent;
      if (typeof e?.type === 'string' && typeof e.seq === 'number') out.push(e);
    } catch { /* a torn last line after a crash: skip it */ }
  }
  return out;
}

function applyEvent(turns: TurnRecord[], e: LoggedEvent): void {
  if (e.type === 'turn/start') { turns.push({ turnId: e.turnId, userText: e.userText, steps: [], reason: null, outcome: null }); return; }
  if (!('turnId' in e)) return;
  const t = [...turns].reverse().find((x) => x.turnId === e.turnId);
  if (!t) return;
  if (e.type === 'tool/result') t.steps.push(e.result);
  else if (e.type === 'turn/end' && t.reason === null) { t.reason = e.reason; t.outcome = e.outcome; if (e.stats) t.stats = e.stats; }
}

export function foldTurns(events: LoggedEvent[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  for (const e of events) applyEvent(turns, e);
  return turns;
}

export function foldChat(events: LoggedEvent[]): ChatRecord[] {
  return events.filter((e): e is Extract<LoggedEvent, { type: 'chat/message' }> => e.type === 'chat/message').map((e) => e.message).slice(-MAX_CHAT);
}

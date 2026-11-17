import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryItem } from '../../shared/agentTypes';

const MAX_ITEMS = 200;
const MAX_TEXT = 300;
/** Up to this many memories all go into the prompt; above it, only relevant + recent ones. */
const ALL_UNDER = 30;
const PICK = 20;
const RECENT = 5;

/** Overlapping character pairs (works for Chinese without a tokenizer; lower-cased for English). */
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
const overlap = (a: Set<string>, b: Set<string>): number => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

/**
 * Preferences the user explicitly asked to keep (favourite editor, project folders…).
 * Memory helps the model understand requests; it is NEVER a permission — the executor ignores it.
 */
export class AgentMemory {
  private items: MemoryItem[] = [];
  private readonly file: string;

  constructor(baseDir: string) {
    this.file = path.join(baseDir, 'memory.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        this.items = raw.filter((m): m is MemoryItem => typeof m?.id === 'string' && typeof m?.text === 'string').slice(0, MAX_ITEMS);
      }
    } catch { /* first run */ }
  }

  list(): MemoryItem[] { return this.items.map((m) => ({ ...m })); }

  add(category: string, text: string): MemoryItem {
    const clean = text.trim().slice(0, MAX_TEXT);
    if (!clean) throw new Error('记忆内容不能为空');
    const existing = this.items.find((m) => m.text === clean);
    if (existing) return { ...existing };
    const now = new Date().toISOString();
    const item: MemoryItem = { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, category: category.trim().slice(0, 30) || '偏好', text: clean, createdAt: now, updatedAt: now };
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.shift();
    this.save();
    return { ...item };
  }

  update(id: string, text: string): boolean {
    const m = this.items.find((x) => x.id === id);
    const clean = text.trim().slice(0, MAX_TEXT);
    if (!m || !clean) return false;
    m.text = clean;
    m.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  /**
   * Text for the system prompt. With many memories only the relevant ones go in: those sharing the most
   * character pairs with the request, plus the most recent few (so a fresh preference is never lost).
   */
  promptBlock(query = ''): string {
    if (this.items.length === 0) return '（暂无）';
    const line = (m: MemoryItem): string => `- [${m.id}] (${m.category}) ${m.text}`;
    if (this.items.length <= ALL_UNDER) return this.items.map(line).join('\n');
    const q = bigrams(query);
    const recent = new Set(this.items.slice(-RECENT).map((m) => m.id));
    const scored = this.items
      .map((m, i) => ({ m, i, score: recent.has(m.id) ? Infinity : overlap(q, bigrams(`${m.category} ${m.text}`)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.i - a.i)
      .slice(0, PICK)
      .sort((a, b) => a.i - b.i);
    const left = this.items.length - scored.length;
    return [...scored.map((x) => line(x.m)), `（另有 ${left} 条和这次请求关系不大的记忆没有列出；需要时可以用 list_memories 查看全部）`].join('\n');
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error('[agent-memory] save', err); }
  }
}

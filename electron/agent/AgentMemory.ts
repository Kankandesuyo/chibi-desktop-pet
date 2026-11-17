import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryItem } from '../../shared/agentTypes';

const MAX_ITEMS = 200;
const MAX_TEXT = 300;

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

  /** Text for the system prompt. */
  promptBlock(): string {
    if (this.items.length === 0) return '（暂无）';
    return this.items.map((m) => `- [${m.id}] (${m.category}) ${m.text}`).join('\n');
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

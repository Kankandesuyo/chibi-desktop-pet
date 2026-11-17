import * as fs from 'node:fs';
import * as path from 'node:path';

export type JournalOp =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'create'; path: string; isDir: boolean }
  | { kind: 'overwrite'; path: string; backup: string }
  | { kind: 'trash'; path: string };

interface JournalEntry { id: string; taskId: string; ts: string; tool: string; ops: JournalOp[] }

const MAX_ENTRIES = 50;

/**
 * Remembers what file operations did, so a task can be undone ("把刚才的整理撤销").
 * Overwritten files are backed up first; moves are reversed; created files are removed only if unchanged.
 */
export class FileJournal {
  private entries: JournalEntry[] = [];
  private readonly file: string;
  readonly backupDir: string;

  constructor(baseDir: string) {
    this.file = path.join(baseDir, 'journal.json');
    this.backupDir = path.join(baseDir, 'backups');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) this.entries = raw as JournalEntry[];
    } catch { /* first run */ }
  }

  record(taskId: string, tool: string, ops: JournalOp[]): void {
    if (ops.length === 0) return;
    this.entries.push({ id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, taskId, ts: new Date().toISOString(), tool, ops });
    this.entries = this.entries.slice(-MAX_ENTRIES);
    this.save();
  }

  /** Copies a file aside before it gets overwritten. */
  backup(p: string): string {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const dest = path.join(this.backupDir, `${Date.now()}-${path.basename(p)}`);
    fs.copyFileSync(p, dest);
    return dest;
  }

  recent(n = 10): { id: string; taskId: string; ts: string; tool: string; count: number }[] {
    return this.entries.slice(-n).reverse().map((e) => ({ id: e.id, taskId: e.taskId, ts: e.ts, tool: e.tool, count: e.ops.length }));
  }

  /** Paths an undo would touch (for the permission check and the confirmation preview). */
  describe(selector: { taskId?: string; entryId?: string }): { paths: string[]; lines: string[] } {
    const paths: string[] = [];
    const lines: string[] = [];
    for (const e of this.select(selector)) {
      for (const op of e.ops) {
        if (op.kind === 'move') { paths.push(op.from, op.to); lines.push(`移回：${op.to} → ${op.from}`); }
        else if (op.kind === 'overwrite') { paths.push(op.path); lines.push(`恢复覆盖前的内容：${op.path}`); }
        else if (op.kind === 'create') { paths.push(op.path); lines.push(`删除新建的${op.isDir ? '空文件夹' : '文件'}：${op.path}`); }
        else lines.push(`已放入回收站（需在回收站手动还原）：${op.path}`);
      }
    }
    return { paths, lines };
  }

  private select(selector: { taskId?: string; entryId?: string }): JournalEntry[] {
    if (selector.entryId) return this.entries.filter((e) => e.id === selector.entryId);
    if (selector.taskId) return this.entries.filter((e) => e.taskId === selector.taskId);
    const last = this.entries[this.entries.length - 1];
    return last ? this.entries.filter((e) => e.taskId === last.taskId) : [];
  }

  /** Reverses the selected entries, newest first. Returns per-op results; never throws. */
  undo(selector: { taskId?: string; entryId?: string }): { done: string[]; failed: string[] } {
    const done: string[] = [];
    const failed: string[] = [];
    const chosen = this.select(selector);
    for (const e of [...chosen].reverse()) {
      for (const op of [...e.ops].reverse()) {
        try {
          if (op.kind === 'move') {
            if (!fs.existsSync(op.to)) throw new Error('文件已不在原位置');
            if (fs.existsSync(op.from)) throw new Error('原位置已有同名文件');
            fs.mkdirSync(path.dirname(op.from), { recursive: true });
            fs.renameSync(op.to, op.from);
            done.push(`已移回 ${op.from}`);
          } else if (op.kind === 'overwrite') {
            fs.copyFileSync(op.backup, op.path);
            done.push(`已恢复 ${op.path}`);
          } else if (op.kind === 'create') {
            if (op.isDir) fs.rmdirSync(op.path);        // only succeeds when still empty
            else fs.unlinkSync(op.path);
            done.push(`已删除新建的 ${op.path}`);
          } else {
            failed.push(`${op.path} 在回收站里，请手动还原`);
          }
        } catch (err) {
          failed.push(`${'path' in op ? op.path : op.from}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.entries = this.entries.filter((x) => x.id !== e.id);
    }
    this.save();
    return { done, failed };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 1), 'utf8');
    } catch (err) { console.error('[journal] save', err); }
  }
}

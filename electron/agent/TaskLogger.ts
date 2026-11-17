import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskRecord } from '../../shared/agentTypes';
import type { Redactor } from './redact';

const MAX_TASKS = 100;

/**
 * Audit trail. Every tool call, permission decision and result goes to a JSON-lines file per day
 * (secrets redacted). A short list of recent tasks is kept separately so it survives restarts.
 */
export class TaskLogger {
  readonly logDir: string;
  private readonly tasksFile: string;
  private tasks: TaskRecord[] = [];

  constructor(baseDir: string, private readonly redactor: Redactor) {
    this.logDir = path.join(baseDir, 'logs');
    this.tasksFile = path.join(baseDir, 'tasks.json');
    try { fs.mkdirSync(this.logDir, { recursive: true }); } catch { /* reported on first write */ }
    try {
      const raw = JSON.parse(fs.readFileSync(this.tasksFile, 'utf8')) as unknown;
      if (Array.isArray(raw)) this.tasks = raw.filter((t): t is TaskRecord => typeof t?.id === 'string').slice(-MAX_TASKS);
    } catch { /* first run */ }
  }

  log(taskId: string, event: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), taskId, event, ...(this.redactor.value(data) as object) });
    const file = path.join(this.logDir, `agent-${new Date().toISOString().slice(0, 10)}.jsonl`);
    try { fs.appendFileSync(file, `${line}\n`, 'utf8'); } catch (err) { console.error('[agent-log]', err); }
  }

  startTask(id: string, request: string): void {
    this.tasks.push({ id, request: this.redactor.text(request).slice(0, 300), status: 'running', startedAt: new Date().toISOString(), toolCalls: 0 });
    this.tasks = this.tasks.slice(-MAX_TASKS);
    this.log(id, 'task_start', { request });
    this.save();
  }

  countToolCall(id: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (t) t.toolCalls += 1;
  }

  endTask(id: string, status: TaskRecord['status'], summary: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (t) Object.assign(t, { status, endedAt: new Date().toISOString(), summary: this.redactor.text(summary).slice(0, 300) });
    this.log(id, 'task_end', { status, summary });
    this.save();
  }

  recentTasks(n = 30): TaskRecord[] { return this.tasks.slice(-n).reverse(); }

  /** Lines of the audit log for one task (newest day files first). */
  readTaskLog(taskId: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let files: string[] = [];
    try { files = fs.readdirSync(this.logDir).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, 3); } catch { return out; }
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(this.logDir, f), 'utf8').split('\n')) {
        if (!line.includes(taskId)) continue;
        try { const j = JSON.parse(line) as Record<string, unknown>; if (j.taskId === taskId) out.push(j); } catch { /* skip */ }
      }
    }
    return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }

  private save(): void {
    try {
      const tmp = `${this.tasksFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.tasks, null, 1), 'utf8');
      fs.renameSync(tmp, this.tasksFile);
    } catch (err) { console.error('[agent-log] save tasks', err); }
  }
}

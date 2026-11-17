import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineTool, type AnyTool } from '../types';

const IS_WIN = process.platform === 'win32';
const MAX_BUFFER = 64 * 1024;

interface Managed { id: string; name: string; command: string; cwd: string; child: ChildProcess; output: string; startedAt: string; exitCode: number | null }

function shellSpawn(command: string, cwd: string): ChildProcess {
  return IS_WIN
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, windowsVerbatimArguments: true, windowsHide: true })
    : spawn('/bin/sh', ['-c', command], { cwd, detached: true });
}

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { try { child.kill(); } catch { /* already gone */ } }
}

/** Runs commands the user approved, with a working directory, a timeout, and output capture. */
export class ProcessManager {
  private readonly procs = new Map<string, Managed>();

  run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = shellSpawn(command, cwd);
      let output = ''; let timedOut = false;
      const add = (d: Buffer): void => { output += d.toString('utf8'); if (output.length > MAX_BUFFER) output = output.slice(-MAX_BUFFER); };
      child.stdout?.on('data', add); child.stderr?.on('data', add);
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const onAbort = (): void => killTree(child);
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => { output += `\n${e.message}`; });
      child.on('close', (code) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve({ exitCode: code, output, timedOut }); });
    });
  }

  start(name: string, command: string, cwd: string): Managed {
    const id = `p${Date.now().toString(36)}`;
    const child = shellSpawn(command, cwd);
    const m: Managed = { id, name, command, cwd, child, output: '', startedAt: new Date().toISOString(), exitCode: null };
    const add = (d: Buffer): void => { m.output += d.toString('utf8'); if (m.output.length > MAX_BUFFER) m.output = m.output.slice(-MAX_BUFFER); };
    child.stdout?.on('data', add); child.stderr?.on('data', add);
    child.on('close', (code) => { m.exitCode = code ?? -1; });
    child.on('error', (e) => { m.output += `\n${e.message}`; m.exitCode = -1; });
    this.procs.set(id, m);
    return m;
  }

  async stop(id: string): Promise<boolean> {
    const m = this.procs.get(id);
    if (!m) return false;
    killTree(m.child);
    for (let i = 0; i < 20 && m.exitCode === null; i++) await new Promise((r) => setTimeout(r, 200));
    return m.exitCode !== null;
  }

  get(id: string): Managed | undefined { return this.procs.get(id); }

  list(): { id: string; name: string; command: string; cwd: string; running: boolean; startedAt: string; pid?: number }[] {
    return [...this.procs.values()].map((m) => ({ id: m.id, name: m.name, command: m.command, cwd: m.cwd, running: m.exitCode === null, startedAt: m.startedAt, pid: m.child.pid }));
  }

  stopAll(): void { for (const m of this.procs.values()) killTree(m.child); }
}

const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s);

const projectTree = defineTool<{ path: string; depth?: number; maxEntries?: number }>({
  name: 'project_tree', group: 'dev', riskLevel: 'low', requiresConfirmation: false,
  description: '列出代码项目的目录结构（自动跳过 node_modules、.git、dist 等）。',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 6, description: '默认 3' }, maxEntries: { type: 'integer', minimum: 10, maximum: 1000, description: '默认 400' } }, required: ['path'] },
  title: (a) => `查看项目结构 ${a.path}`,
  paths: (a, ctx) => ({ read: [ctx.resolvePath(a.path)] }),
  execute: async (a, ctx) => {
    const root = ctx.resolvePath(a.path);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { ok: false, summary: '不是文件夹', error: `${root} 不存在` };
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.idea', 'release', 'dist-electron']);
    const lines: string[] = []; const max = a.maxEntries ?? 400; let truncated = false;
    const walk = (dir: string, depth: number, prefix: string): void => {
      if (lines.length >= max) { truncated = true; return; }
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name)); } catch { return; }
      for (const e of entries) {
        if (lines.length >= max) { truncated = true; return; }
        if (e.isDirectory() && skip.has(e.name)) { lines.push(`${prefix}${e.name}/ (已跳过)`); continue; }
        lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory() && depth < (a.depth ?? 3)) walk(path.join(dir, e.name), depth + 1, `${prefix}  `);
      }
    };
    walk(root, 1, '');
    return { ok: true, summary: `${root} 的结构（${lines.length} 项${truncated ? '，已截断' : ''}）`, data: { root, tree: lines.join('\n'), truncated } };
  },
});

const gitStatus = defineTool<{ path: string }>({
  name: 'git_status', group: 'dev', riskLevel: 'low', requiresConfirmation: false,
  description: '查看 Git 仓库状态（当前分支、改动的文件、最近 5 次提交）。只读。',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  title: (a) => `查看 Git 状态 ${a.path}`,
  paths: (a, ctx) => ({ read: [ctx.resolvePath(a.path)] }),
  execute: async (a, ctx) => {
    const cwd = ctx.resolvePath(a.path);
    const git = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
      execFile('git', ['-C', cwd, ...args], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)));
    });
    try {
      const [status, log] = await Promise.all([git(['status', '--porcelain=v1', '--branch']), git(['log', '-5', '--oneline']).catch(() => '')]);
      const lines = status.trim().split('\n');
      return { ok: true, summary: `${lines[0]?.replace(/^## /, '分支 ')}，${Math.max(0, lines.length - 1)} 个文件有改动`, data: { status: status.trim(), recentCommits: log.trim() }, external: true };
    } catch (err) {
      return { ok: false, summary: '不是 Git 仓库或没有安装 git', error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const runCommand = defineTool<{ command: string; cwd: string; timeoutSec?: number }>({
  name: 'run_command', group: 'dev', riskLevel: 'high', requiresConfirmation: true,
  description: '在指定工作目录里运行一条命令（如 npm test、npm run build、pytest），等待结束并返回输出。每次都需要用户确认完整命令。长期运行的服务请用 start_dev_server。',
  inputSchema: { type: 'object', properties: {
    command: { type: 'string', minLength: 1, maxLength: 1000 },
    cwd: { type: 'string', description: '工作目录（必须在允许的文件夹里）' },
    timeoutSec: { type: 'integer', minimum: 5, maximum: 600, description: '超时秒数，默认 120' },
  }, required: ['command', 'cwd'] },
  title: (a) => `运行命令：${a.command}`,
  paths: (a, ctx) => ({ write: [ctx.resolvePath(a.cwd)] }),
  assess: (a, ctx) => ({ risk: 'high', reason: '会在你的电脑上执行命令', preview: [`命令：${a.command}`, `工作目录：${ctx.resolvePath(a.cwd)}`, `超时：${a.timeoutSec ?? 120} 秒`] }),
  execute: async (a, ctx) => {
    const cwd = ctx.resolvePath(a.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { ok: false, summary: '工作目录不存在', error: `${cwd} 不存在` };
    const r = await ctx.services.processes.run(a.command, cwd, (a.timeoutSec ?? 120) * 1000, ctx.signal);
    const ok = r.exitCode === 0 && !r.timedOut;
    return {
      ok, summary: r.timedOut ? '命令超时，已结束' : `命令结束，退出码 ${r.exitCode}`,
      data: { exitCode: r.exitCode, timedOut: r.timedOut, output: tail(r.output, 8000) }, external: true,
      error: ok ? undefined : r.timedOut ? '超时' : `退出码 ${r.exitCode}`,
    };
  },
});

const startDevServer = defineTool<{ command: string; cwd: string; name?: string }>({
  name: 'start_dev_server', group: 'dev', riskLevel: 'high', requiresConfirmation: true,
  description: '在后台启动长期运行的命令（如 uvicorn main:app --reload、npm run dev），返回 id。用 read_process_output 看输出，用 stop_dev_server 停止。每次都需要确认。',
  inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 1000 }, cwd: { type: 'string' }, name: { type: 'string', maxLength: 60 } }, required: ['command', 'cwd'] },
  title: (a) => `后台启动：${a.command}`,
  paths: (a, ctx) => ({ write: [ctx.resolvePath(a.cwd)] }),
  assess: (a, ctx) => ({ risk: 'high', reason: '会在后台持续运行一个命令', preview: [`命令：${a.command}`, `工作目录：${ctx.resolvePath(a.cwd)}`] }),
  execute: async (a, ctx) => {
    const cwd = ctx.resolvePath(a.cwd);
    if (!fs.existsSync(cwd)) return { ok: false, summary: '工作目录不存在', error: `${cwd} 不存在` };
    const m = ctx.services.processes.start(a.name ?? a.command.slice(0, 40), a.command, cwd);
    return { ok: true, summary: `已在后台启动（id ${m.id}）`, data: { id: m.id, pid: m.child.pid } };
  },
  verify: async (_a, r, ctx) => {
    await new Promise((res) => setTimeout(res, 3000));
    const m = ctx.services.processes.get((r.data as { id: string }).id);
    if (!m) return { verified: false, detail: '找不到进程' };
    return m.exitCode === null
      ? { verified: true, detail: '3 秒后仍在运行' }
      : { verified: false, detail: `进程已退出（${m.exitCode}）：${tail(m.output, 400)}` };
  },
});

const stopDevServer = defineTool<{ id: string }>({
  name: 'stop_dev_server', group: 'dev', riskLevel: 'medium', requiresConfirmation: false,
  description: '停止由 start_dev_server 启动的后台命令。',
  inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 40 } }, required: ['id'] },
  title: (a) => `停止后台命令 ${a.id}`,
  execute: async (a, ctx) => (await ctx.services.processes.stop(a.id) ? { ok: true, summary: '已停止' } : { ok: false, summary: '没能停止', error: `找不到或无法停止 ${a.id}` }),
});

const listStarted = defineTool<Record<string, never>>({
  name: 'list_dev_servers', group: 'dev', riskLevel: 'low', requiresConfirmation: false,
  description: '列出由桌宠在后台启动的命令及其状态。',
  inputSchema: { type: 'object', properties: {} },
  title: () => '查看后台命令',
  execute: async (_a, ctx) => { const l = ctx.services.processes.list(); return { ok: true, summary: `${l.filter((x) => x.running).length} 个正在运行`, data: l }; },
});

const readOutput = defineTool<{ id: string; tailChars?: number }>({
  name: 'read_process_output', group: 'dev', riskLevel: 'low', requiresConfirmation: false,
  description: '查看后台命令最近的输出（日志）。',
  inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 40 }, tailChars: { type: 'integer', minimum: 100, maximum: 20_000 } }, required: ['id'] },
  title: (a) => `查看输出 ${a.id}`,
  execute: async (a, ctx) => {
    const m = ctx.services.processes.get(a.id);
    if (!m) return { ok: false, summary: '找不到', error: `没有 ${a.id}` };
    return { ok: true, summary: m.exitCode === null ? '正在运行' : `已退出（${m.exitCode}）`, data: { running: m.exitCode === null, output: tail(m.output, a.tailChars ?? 4000) }, external: true };
  },
});

export const devTools: AnyTool[] = [projectTree, gitStatus, runCommand, startDevServer, stopDevServer, listStarted, readOutput];

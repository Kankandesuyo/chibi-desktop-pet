import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

export interface McpToolSpec { name: string; description?: string; inputSchema?: Record<string, unknown> }
export interface McpCallResult { isError: boolean; text: string; structured?: unknown }

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const PROTOCOL_VERSION = '2025-06-18';

/** One argument for cmd.exe: always quoted, so spaces and & | < > ^ stay literal; inner quotes doubled. */
const cmdQuote = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * How to start an MCP server. On Windows a real .exe / .com is started directly (paths with spaces such as
 * "C:\Program Files\nodejs\node.exe" just work). Anything else (npx, uvx, a .cmd / .bat shim) needs cmd.exe,
 * which Node will not run without a shell; every part is quoted so the command line is not re-split.
 */
export function launchSpec(command: string, args: string[], platform: NodeJS.Platform): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win32' || /\.(exe|com)$/i.test(command)) return { file: command, args, verbatim: false };
  const line = [command, ...args].map(cmdQuote).join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/** Minimal Model Context Protocol client over stdio (newline-delimited JSON-RPC 2.0). */
export class McpStdioClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderr = '';
  serverInfo: { name?: string; version?: string } = {};

  constructor(private readonly cfg: { command: string; args: string[]; cwd?: string; env?: Record<string, string> }) {}

  async start(timeoutMs = 20_000): Promise<void> {
    const launch = launchSpec(this.cfg.command, this.cfg.args, process.platform);
    const child = spawn(launch.file, launch.args, {
      cwd: this.cfg.cwd, env: { ...process.env, ...this.cfg.env }, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, windowsVerbatimArguments: launch.verbatim,
    });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-4000); });
    child.on('exit', () => this.failAll(new Error(`MCP 服务已退出${this.stderr ? `：${this.stderr.trim().split('\n').pop()}` : ''}`)));
    child.on('error', (e) => this.failAll(e));
    const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
    rl.on('line', (line) => this.onLine(line));
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'chibi-desktop-pet', version: '0.2.0' },
    }, timeoutMs) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = init?.serverInfo ?? {};
    this.notify('notifications/initialized', {});
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id === 'number' && this.pending.has(msg.id) && !msg.method) {
      const p = this.pending.get(msg.id) as Pending;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP 错误'));
      else p.resolve(msg.result);
    } else if (msg.method && typeof msg.id === 'number') {
      // Server-initiated requests (sampling, roots…) are not supported: answer with an error.
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by this client' } });
    }
  }

  private write(obj: unknown): void { this.child?.stdin?.write(`${JSON.stringify(obj)}\n`); }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error('MCP 服务没有运行'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP 请求超时：${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }

  async listTools(): Promise<McpToolSpec[]> {
    const out: McpToolSpec[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}) as { tools?: McpToolSpec[]; nextCursor?: string };
      out.push(...(r?.tools ?? []));
      if (!r?.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const abort = new Promise<never>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true }));
    const r = await Promise.race([this.request('tools/call', { name, arguments: args }, 120_000), abort]) as {
      content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown;
    };
    const text = (r?.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
    return { isError: Boolean(r?.isError), text, structured: r?.structuredContent };
  }

  private failAll(e: Error): void {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(e); this.pending.delete(id); }
  }

  close(): void {
    this.failAll(new Error('MCP 连接已关闭'));
    try { this.child?.stdin?.end(); this.child?.kill(); } catch { /* gone */ }
    this.child = null;
  }
}

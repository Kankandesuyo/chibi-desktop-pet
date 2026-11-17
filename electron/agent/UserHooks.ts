import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HooksStatus } from '../../shared/agentTypes';

/**
 * User-configured hooks, in Claude Code's format (<agent data>/hooks.json):
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "run_command|write_file",
 *                                   "hooks": [ { "type": "command", "command": "powershell -File C:\\check.ps1", "timeout": 10 } ] } ] } }
 *
 * Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop. The command gets one JSON object on stdin
 * (hook_event_name, session_id, tool_name, tool_input, tool_response, prompt). Exit code 2, or stdout JSON
 * {"decision":"block","reason":…} (or hookSpecificOutput.permissionDecision "deny"), blocks; other failures
 * are only logged. A hook can block or add feedback, never grant: allowing is still up to the permission rules.
 *
 * Hooks run commands, so they only run after the user approves the file in settings; approval is tied to a
 * hash of the file, so any change has to be approved again. The agent cannot write this file (its data
 * folder is protected).
 */

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';
export const HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];

interface HookCommand { command: string; timeoutMs: number }
interface HookGroup { matcher: RegExp | null; commands: HookCommand[] }
type HookConfig = Partial<Record<HookEvent, HookGroup[]>>;

export interface HookOutcome { block: boolean; reason: string; output: string }

const APPROVAL_KEY = 'hooks.json';
const MAX_OUTPUT = 4000;

export interface HookApprovals { get(): Record<string, string>; set(name: string, hash: string | null): void }

export class UserHooks {
  readonly file: string;
  private config: HookConfig = {};
  private hash = '';
  private error = '';

  constructor(baseDir: string, private readonly approvals: HookApprovals, private readonly log: (event: string, data: Record<string, unknown>) => void = () => undefined) {
    this.file = path.join(baseDir, 'hooks.json');
    this.reload();
  }

  /** Re-reads hooks.json (cheap; called before each turn so edits show up as "needs approval"). */
  reload(): void {
    this.config = {}; this.error = ''; this.hash = '';
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    this.hash = createHash('sha256').update(text).digest('hex');
    try { this.config = parseHooks(JSON.parse(text.replace(/^\uFEFF/, ''))); } catch (err) {
      this.error = `hooks.json 格式不对：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private count(): number { return HOOK_EVENTS.reduce((n, e) => n + (this.config[e]?.reduce((m, g) => m + g.commands.length, 0) ?? 0), 0); }

  status(): HooksStatus {
    const count = this.count();
    const state = this.error ? 'error' : count === 0 ? 'none' : this.approved() ? 'active' : 'pending';
    return { file: this.file, state, count, ...(this.error ? { detail: this.error } : {}), events: HOOK_EVENTS.filter((e) => (this.config[e]?.length ?? 0) > 0) };
  }

  private approved(): boolean { return !!this.hash && this.approvals.get()[APPROVAL_KEY] === this.hash; }

  /** Approve (or withdraw approval for) the file as it is right now. */
  approve(yes: boolean): void { this.reload(); this.approvals.set(APPROVAL_KEY, yes && this.hash && !this.error ? this.hash : null); }

  active(): boolean { return !this.error && this.count() > 0 && this.approved(); }

  /** Creates an empty, commented hooks.json if there is none (so the user can open and edit it). */
  ensureTemplate(): void {
    if (fs.existsSync(this.file)) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({
      _说明: '和 Claude Code 相同的格式。事件：PreToolUse、PostToolUse、UserPromptSubmit、Stop。命令从标准输入收到一个 JSON；退出码 2 表示拦下。改动后要在 设置 → 智能体 → 钩子 里重新批准才会生效。',
      hooks: {},
    }, null, 2)}\n`, 'utf8');
    this.reload();
  }

  /** Runs every approved hook for this event (and tool, for tool events). The first block wins. */
  async run(event: HookEvent, input: Record<string, unknown>, tool?: string): Promise<HookOutcome> {
    const outputs: string[] = [];
    if (!this.active()) return { block: false, reason: '', output: '' };
    for (const group of this.config[event] ?? []) {
      if (tool !== undefined && group.matcher && !group.matcher.test(tool)) continue;
      for (const cmd of group.commands) {
        const r = await runCommand(cmd, { hook_event_name: event, ...input });
        this.log('user_hook', { event, tool, command: cmd.command.slice(0, 200), code: r.code, timedOut: r.timedOut });
        const decision = parseDecision(r.stdout);
        if (r.code === 2 || decision.block) {
          return { block: true, reason: (decision.reason || r.stderr || r.stdout || '被钩子拦下了').trim().slice(0, MAX_OUTPUT), output: '' };
        }
        if (r.code === 0 && !decision.json && r.stdout.trim()) outputs.push(r.stdout.trim());
        else if (decision.context) outputs.push(decision.context);
      }
    }
    return { block: false, reason: '', output: outputs.join('\n').slice(0, MAX_OUTPUT) };
  }
}

function parseHooks(raw: unknown): HookConfig {
  const root = (raw ?? {}) as Record<string, unknown>;
  const hooks = (root.hooks ?? {}) as Record<string, unknown>;
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('"hooks" 应该是一个对象');
  const out: HookConfig = {};
  for (const event of HOOK_EVENTS) {
    const list = hooks[event];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`${event} 应该是一个数组`);
    out[event] = list.map((g, i): HookGroup => {
      const group = (g ?? {}) as Record<string, unknown>;
      const matcher = typeof group.matcher === 'string' && group.matcher.trim() && group.matcher.trim() !== '*' ? group.matcher.trim() : null;
      let re: RegExp | null = null;
      if (matcher) { try { re = new RegExp(`^(?:${matcher})$`); } catch { throw new Error(`${event}[${i}].matcher 不是有效的正则表达式`); } }
      const commands = (Array.isArray(group.hooks) ? group.hooks : []).map((h) => h as Record<string, unknown>)
        .filter((h) => (h.type === undefined || h.type === 'command') && typeof h.command === 'string' && h.command.trim())
        .map((h) => ({ command: String(h.command).trim().slice(0, 2000), timeoutMs: Math.round(Math.min(120, Math.max(1, Number(h.timeout) || 30)) * 1000) }));
      return { matcher: re, commands };
    });
  }
  return out;
}

function parseDecision(stdout: string): { json: boolean; block: boolean; reason: string; context: string } {
  const t = stdout.trim();
  if (!t.startsWith('{')) return { json: false, block: false, reason: '', context: '' };
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    const specific = (j.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const block = j.decision === 'block' || j.decision === 'deny' || specific.permissionDecision === 'deny' || j.continue === false;
    const reason = String(j.reason ?? specific.permissionDecisionReason ?? j.stopReason ?? '');
    const context = typeof specific.additionalContext === 'string' ? specific.additionalContext : '';
    return { json: true, block, reason, context };
  } catch { return { json: false, block: false, reason: '', context: '' }; }
}

function runCommand(cmd: HookCommand, input: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let timedOut = false;
    let child;
    try {
      child = spawn(cmd.command, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, cmd.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout = (stdout + d.toString('utf8')).slice(-MAX_OUTPUT * 2); });
    child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-MAX_OUTPUT * 2); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr || String(err), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? null : code, stdout, stderr, timedOut }); });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify(input));
  });
}

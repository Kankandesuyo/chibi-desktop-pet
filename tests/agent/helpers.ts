import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentEvent, AgentPetSignal, AgentSettings, ConfirmDecision, ConfirmRequest, McpServerConfig } from '../../shared/agentTypes';
import { TOOL_GROUPS } from '../../shared/agentTypes';
import type { ChatMessage, PetStats } from '../../shared/types';
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions } from '../../electron/agent';
import type { LlmClient, LlmMessage, LlmRequest, LlmTurn } from '../../electron/agent/llm';
import type { DesktopPlatform, InstalledApp, KnownFolders, RunningApp } from '../../electron/agent/types';

export const STATS: PetStats = { mood: 'neutral', affection: 50, energy: 80, interactionCount: 0 };

/** A throw-away "computer": real folders in a temp dir, fake apps, recorded side effects. */
export class FakePlatform implements DesktopPlatform {
  readonly os = process.platform;
  readonly root: string;
  readonly folders: KnownFolders;
  running: RunningApp[] = [{ pid: 100, name: 'explorer', title: '文件资源管理器' }];
  installed: InstalledApp[] = [
    { name: 'Visual Studio Code', target: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code\\Visual Studio Code.lnk', kind: 'shortcut', exe: 'C:\\Code\\Code.exe' },
    { name: 'Notepad', target: 'shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', kind: 'store-app' },
  ];
  opened: string[] = [];
  urls: string[] = [];
  shortcuts: { lnk: string; target: string; args?: string }[] = [];
  launched: { target: string; args?: string[] }[] = [];
  closed: number[] = [];
  drive = '';
  /** Every script the agent asked to run: [script, input, elevated]. */
  scripts: { script: string; input: Record<string, unknown>; elevated: boolean }[] = [];
  /** Answers for powershell(): first matching regex on the script wins. */
  shellAnswers: { match: RegExp; result: import('../../electron/agent/types').ShellResult }[] = [];
  drives(): string[] { return [this.folders.home, path.join(this.drive, 'C'), path.join(this.drive, 'D')]; }
  async powershell(script: string, input: Record<string, unknown>, opts: { elevated: boolean }): Promise<import('../../electron/agent/types').ShellResult> {
    this.scripts.push({ script, input, elevated: opts.elevated });
    return this.shellAnswers.find((a) => a.match.test(script))?.result ?? { ok: true, output: '' };
  }
  private nextPid = 2000;

  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-'));
    const home = path.join(this.root, 'home');
    const f = (n: string): string => { const p = path.join(home, n); fs.mkdirSync(p, { recursive: true }); return p; };
    this.folders = {
      home, desktop: f('Desktop'), documents: f('Documents'), downloads: f('Downloads'), pictures: f('Pictures'),
      music: f('Music'), videos: f('Videos'), temp: f('Temp'), protected: [path.join(home, 'AppData')],
      system: [f('Windows'), f('Program Files')],
    };
    this.drive = path.join(this.root, 'drives');
    for (const d of ['C', 'D']) fs.mkdirSync(path.join(this.drive, d), { recursive: true });
    fs.mkdirSync(path.join(home, 'AppData'), { recursive: true });
  }
  knownFolders(): KnownFolders { return this.folders; }
  selfLaunch() { return { target: 'C:\\Program Files\\Chibi Desktop Pet\\Chibi Desktop Pet.exe', args: '' }; }
  async openPath(p: string): Promise<string> { this.opened.push(p); return ''; }
  async openUrl(url: string): Promise<void> { this.urls.push(url); }
  async trash(p: string): Promise<void> {
    const bin = path.join(this.root, 'RecycleBin'); fs.mkdirSync(bin, { recursive: true });
    fs.renameSync(p, path.join(bin, `${Date.now()}-${path.basename(p)}`));
  }
  async createShortcut(lnk: string, o: { target: string; args?: string }): Promise<boolean> {
    fs.writeFileSync(lnk, JSON.stringify(o)); this.shortcuts.push({ lnk, target: o.target, args: o.args }); return true;
  }
  async listRunningApps(): Promise<RunningApp[]> { return [...this.running]; }
  async findInstalledApps(q: string): Promise<InstalledApp[]> { return this.installed.filter((a) => a.name.toLowerCase().includes(q.toLowerCase())); }
  async launch(a: { target: string; args?: string[] }): Promise<{ pid?: number }> {
    this.launched.push(a);
    const app = this.installed.find((x) => x.target === a.target);
    const pid = this.nextPid++;
    setTimeout(() => this.running.push({ pid, name: (app?.exe ? path.win32.basename(app.exe, '.exe') : 'app'), title: app?.name ?? a.target }), 300);
    return { pid };
  }
  async focus(): Promise<boolean> { return true; }
  async close(sel: { pid?: number }): Promise<number> {
    const before = this.running.length;
    this.running = this.running.filter((r) => r.pid !== sel.pid);
    if (sel.pid) this.closed.push(sel.pid);
    return before - this.running.length;
  }
  async isRunning(sel: { pid?: number; name?: string }): Promise<boolean> {
    return this.running.some((r) => (sel.pid ? r.pid === sel.pid : r.name === sel.name));
  }
  ui = {
    activeWindow: async () => ({ title: '记事本', pid: 1, processName: 'notepad', handle: 1 }),
    listWindows: async () => [],
    inspect: async () => [],
    click: async () => 'invoked',
    typeText: async () => 'value-set',
    hotkey: async () => 'sent',
    scroll: async () => 'scrolled',
    waitForWindow: async () => null,
  };
  async captureScreen(): Promise<Buffer> { return Buffer.from('89504e470d0a1a0a', 'hex'); }
  cleanup(): void { fs.rmSync(this.root, { recursive: true, force: true }); }
}

type Step = LlmTurn | ((messages: LlmMessage[]) => LlmTurn) | Error;

/** A "model" that follows a script: one entry per model turn. Records what it was sent. */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private steps: Step[]) {}
  push(...s: Step[]): void { this.steps.push(...s); }
  async complete(req: LlmRequest): Promise<LlmTurn> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const s = this.steps.shift();
    if (s === undefined) throw new Error('scripted model ran out of turns');
    if (s instanceof Error) throw s;
    const turn = typeof s === 'function' ? s(req.messages) : s;
    if (turn.content) req.onDelta?.(turn.content);
    return turn;
  }
}

let callSeq = 0;
export const call = (name: string, args: Record<string, unknown>, content = ''): LlmTurn =>
  ({ content, toolCalls: [{ id: `call_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }], finishReason: 'tool_calls', reasoning: '' });
export const calls = (...list: [string, Record<string, unknown>][]): LlmTurn =>
  ({ content: '', toolCalls: list.map(([name, args]) => ({ id: `call_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })), finishReason: 'tool_calls', reasoning: '' });
export const say = (content: string): LlmTurn => ({ content, toolCalls: [], finishReason: 'stop', reasoning: '' });

/** Last tool message the model received (parsed). */
export function lastToolResult(messages: LlmMessage[]): Record<string, unknown> {
  const m = [...messages].reverse().find((x) => x.role === 'tool' || (x.role === 'user' && typeof x.content === 'string' && x.content.includes('<tool_result')));
  if (!m) throw new Error('no tool result');
  const text = String(m.content);
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(json) as Record<string, unknown>;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  enabled: true, autoApproveMedium: false, readOnly: false, permissionRules: { allow: [], deny: [] }, allowedRoots: [], fullDiskAccess: false,
  toolGroups: Object.fromEntries(TOOL_GROUPS.map((g) => [g, true])) as AgentSettings['toolGroups'],
  toolProtocol: 'native', maxSteps: 20, vision: { baseUrl: '', model: '', hasApiKey: false },
};

export interface Harness {
  platform: FakePlatform;
  rt: AgentRuntime;
  llm: ScriptedLlm;
  settings: AgentSettings;
  baseDir: string;
  approvals: Record<string, string>;
  mcp: McpServerConfig[];
  /** Runs one request; confirmations are answered by `decide` (default: allow). */
  run(text: string, opts?: { decide?: (r: ConfirmRequest) => ConfirmDecision | Promise<ConfirmDecision>; history?: ChatMessage[] }): Promise<RunResult>;
  cleanup(): void;
}

export interface RunResult { events: AgentEvent[]; pet: AgentPetSignal[]; confirms: ConfirmRequest[]; done?: Extract<AgentEvent, { type: 'done' }>; error?: string }

export function makeHarness(steps: Step[] = [], opts: { baseDir?: string; platform?: FakePlatform; settings?: Partial<AgentSettings>; secrets?: string[]; persona?: () => string; vision?: (question: string) => Promise<string>; pointAt?: AgentRuntimeOptions['pointAt']; builtinSkillsDir?: string } = {}): Harness {
  const platform = opts.platform ?? new FakePlatform();
  const baseDir = opts.baseDir ?? path.join(platform.root, 'agent-data');
  const llm = new ScriptedLlm(steps);
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const approvals: Record<string, string> = {};
  const mcp: McpServerConfig[] = [];
  const rt = createAgentRuntime({
    baseDir, platform, llm, settings: () => settings,
    vision: async (_png, question) => (opts.vision ? opts.vision(question) : '屏幕上是一个记事本窗口'),
    ...(opts.pointAt ? { pointAt: opts.pointAt } : {}),
    secrets: () => opts.secrets ?? [],
    browser: () => ({ profileDir: path.join(baseDir, 'browser'), headless: true, executablePath: '/usr/bin/google-chrome', channels: [] }),
    approvals: { get: () => approvals, set: (n, h) => { if (h) approvals[n] = h; else delete approvals[n]; } },
    mcpServers: () => mcp,
    persona: opts.persona,
    ...(opts.builtinSkillsDir ? { builtinSkillsDir: opts.builtinSkillsDir } : {}),
  });
  let seq = 0;
  return {
    platform, rt, llm, settings, baseDir, approvals, mcp,
    async run(text, o = {}) {
      const requestId = `t${++seq}-${Date.now().toString(36)}`;
      const res: RunResult = { events: [], pet: [], confirms: [] };
      const history: ChatMessage[] = [...(o.history ?? []), { role: 'user', content: text }];
      await rt.controller.run(requestId, history, STATS, {
        emit: (e) => {
          res.events.push(e);
          if (e.type === 'confirm') {
            res.confirms.push(e.request);
            void Promise.resolve((o.decide ?? (() => 'allow'))(e.request)).then((d) => rt.controller.resolveConfirm(e.request.confirmId, d));
          }
          if (e.type === 'done') res.done = e;
          if (e.type === 'error') res.error = e.message;
        },
        pet: (s) => res.pet.push(s),
      });
      return res;
    },
    cleanup() { void rt.shutdown(); platform.cleanup(); },
  };
}

export const steps = (r: RunResult) => r.events.filter((e): e is Extract<AgentEvent, { type: 'step' }> => e.type === 'step').map((e) => e.step);
export const finalSteps = (r: RunResult) => {
  const m = new Map<string, ReturnType<typeof steps>[number]>();
  for (const s of steps(r)) m.set(s.stepId, s);
  return [...m.values()];
};

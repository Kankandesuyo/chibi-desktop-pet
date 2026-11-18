import type { RiskLevel, ToolGroup } from '../../shared/agentTypes';

/** Minimal JSON-Schema subset used for tool inputs (validated before anything runs). */
export type JsonSchema =
  | { type: 'string'; description?: string; enum?: readonly string[]; maxLength?: number; minLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema; maxItems?: number; minItems?: number }
  | ObjectSchema;

export interface ObjectSchema {
  type: 'object';
  description?: string;
  properties: Record<string, JsonSchema>;
  required?: readonly string[];
}

/** What the platform layer can do. Electron provides the real one; tests provide a fake. */
export interface DesktopPlatform {
  readonly os: NodeJS.Platform;
  knownFolders(): KnownFolders;
  /** How to start this pet itself (for "put your shortcut on my desktop"). */
  selfLaunch(): { target: string; args: string; icon?: string };
  openPath(p: string): Promise<string>;           // '' on success, error text otherwise
  openUrl(url: string): Promise<void>;
  trash(p: string): Promise<void>;
  createShortcut(lnkPath: string, opts: { target: string; args?: string; cwd?: string; description?: string; icon?: string }): Promise<boolean>;
  listRunningApps(): Promise<RunningApp[]>;
  findInstalledApps(query: string): Promise<InstalledApp[]>;
  launch(app: { target: string; args?: string[]; cwd?: string }): Promise<{ pid?: number }>;
  focus(sel: { pid?: number; title?: string }): Promise<boolean>;
  close(sel: { pid?: number; name?: string }, force: boolean): Promise<number>;
  isRunning(sel: { pid?: number; name?: string }): Promise<boolean>;
  ui: UiAutomation;
  captureScreen(): Promise<Buffer>;
  /** Drive roots (C:\\, D:\\ …) for full disk access. */
  drives(): string[];
  /**
   * Runs one of OUR PowerShell scripts; user/model values travel in `input` only (never spliced into code).
   * elevated=true asks Windows for administrator rights (UAC prompt) for this one run.
   */
  powershell(script: string, input: Record<string, unknown>, opts: { elevated: boolean; timeoutMs: number }): Promise<ShellResult>;
}

export interface KnownFolders {
  home: string; desktop: string; documents: string; downloads: string; pictures: string; music: string; videos: string; temp: string;
  /** Folders of the app itself / its data: never writable by the agent (protects its own permissions and config). */
  protected: string[];
  /** Windows, Program Files…: off-limits normally; with full disk access every change there is high risk. */
  system: string[];
}

export interface ShellResult { ok: boolean; output: string; cancelled?: boolean }

export interface RunningApp { pid: number; name: string; title: string; path?: string }
export interface InstalledApp { name: string; target: string; kind: 'shortcut' | 'store-app' | 'exe'; exe?: string }

export interface UiElementInfo { name: string; controlType: string; automationId: string; enabled: boolean; patterns: string[] }
export interface UiWindowInfo { title: string; pid: number; processName: string; handle: number }
export interface UiTarget { window?: string; pid?: number }
export interface UiElementQuery { name?: string; automationId?: string; controlType?: string; index?: number }

export interface UiAutomation {
  activeWindow(): Promise<UiWindowInfo | null>;
  listWindows(): Promise<UiWindowInfo[]>;
  inspect(target: UiTarget, opts: { maxCount: number; nameContains?: string }): Promise<UiElementInfo[]>;
  click(target: UiTarget, el: UiElementQuery): Promise<string>;
  typeText(target: UiTarget, el: UiElementQuery | null, text: string): Promise<string>;
  hotkey(target: UiTarget | null, keys: string): Promise<string>;
  scroll(target: UiTarget, el: UiElementQuery | null, direction: 'up' | 'down', amount: number): Promise<string>;
  waitForWindow(title: string, timeoutMs: number): Promise<UiWindowInfo | null>;
}

/** read: looked at; write: created or receiving items; remove: moved away / renamed / deleted (never a root itself). */
export interface PathAccess { read?: string[]; write?: string[]; remove?: string[] }

export interface RiskAssessment {
  risk: RiskLevel;
  reason?: string;
  preview?: string[];
}

export interface ToolResult {
  ok: boolean;
  /** One short human-readable line. */
  summary: string;
  /** Structured data handed back to the model. */
  data?: unknown;
  error?: string;
  /** The data came from outside (a file, a web page, another program) and must be treated as untrusted. */
  external?: boolean;
}

export interface VerifyResult { verified: boolean; detail: string }

export interface ToolContext {
  taskId: string;
  platform: DesktopPlatform;
  signal: AbortSignal;
  /** Absolute, normalised paths resolved by the permission layer. */
  resolvePath(p: string): string;
  /** The conversation's project folder (relative paths and commands default to it), if one is open. */
  project?: string | null;
  services: AgentServices;
  log(event: string, data: Record<string, unknown>): void;
  /** Present when tool groups are shown on demand (load_tools). */
  toolLoader?: import('./toolLoading').ToolLoader;
}

/** Long-lived helpers a tool may need. */
export interface AgentServices {
  memory: import('./AgentMemory').AgentMemory;
  planner: import('./TaskPlanner').TaskPlanner;
  journal: import('./FileJournal').FileJournal;
  processes: import('./tools/devTools').ProcessManager;
  browser: import('./tools/browserTools').BrowserSession;
  vision: (pngPath: string, question: string, signal: AbortSignal, options?: { json?: boolean }) => Promise<string>;
  /** Shows the user a spot on the primary screen (highlight ring + the pet walks over). Absent in tests / headless. */
  pointAt?: (target: ScreenTarget) => void;
  /** Built-in and user skills (load_skill / save_skill). */
  skills?: import('./Skills').SkillLibrary;
  /** Scheduled / proactive tasks. */
  scheduler?: import('./Scheduler').Scheduler;
  /** Helpers (subagents) for delegate_task. */
  helpers?: { run(task: string, parent: { taskId: string; signal: AbortSignal }): Promise<ToolResult> };
}

/** A spot on the primary display, as fractions of its width and height (0–1), with a short name. */
export interface ScreenTarget { nx: number; ny: number; label: string; note?: string }

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  description: string;
  group: ToolGroup | 'internal';
  inputSchema: ObjectSchema;
  /** Base risk. `assess` may raise it for particular arguments (never lower it). */
  riskLevel: RiskLevel;
  /** true = always ask (even for low risk); false = follow the risk rules. */
  requiresConfirmation: boolean;
  /** Short title for the UI, e.g. "创建文件夹 D:\\x". */
  title(args: A): string;
  /** Paths the call will touch; checked against the allowed folders before anything runs. */
  paths?(args: A, ctx: ToolContext): PathAccess;
  assess?(args: A, ctx: ToolContext): Promise<RiskAssessment> | RiskAssessment;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
  /** Checks the real world after execute, e.g. "does the folder exist now". */
  verify?(args: A, result: ToolResult, ctx: ToolContext): Promise<VerifyResult>;
  /** Where the tool came from: "builtin", "plugin:x", "mcp:y". */
  source?: string;
  /** External schemas (MCP) use JSON-Schema features we don't validate; only "is an object" is checked. */
  looseSchema?: boolean;
  /**
   * Read-only and independent of other calls, so it may run side by side with other such calls in the
   * same step. Only honoured for low-risk tools that never ask the user.
   */
  concurrencySafe?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

export function defineTool<A>(t: ToolDefinition<A>): ToolDefinition<A> { return t; }

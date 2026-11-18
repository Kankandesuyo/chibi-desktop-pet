/** Agent types shared by the main process (which runs the agent) and the renderer (which shows it). */

export type RiskLevel = 'low' | 'medium' | 'high';

export const TOOL_GROUPS = ['files', 'apps', 'system', 'memory', 'ui', 'browser', 'dev', 'admin', 'plugins'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export type ToolProtocol = 'auto' | 'native' | 'json';

export interface AgentSettings {
  /** Chat goes through the agent (with tools). Off = plain chat like before. */
  enabled: boolean;
  /** Medium-risk tools run without asking. High-risk tools ALWAYS ask, whatever this says. */
  autoApproveMedium: boolean;
  /** Read-only mode: only tools that just look may run (she can investigate and plan, not change anything). */
  readOnly: boolean;
  /**
   * Rules like Claude Code's, e.g. "open_url(https://*.bilibili.com/*)". deny = never run;
   * allow = medium-risk calls run without asking (high risk always asks).
   */
  permissionRules: { allow: string[]; deny: string[] };
  /** Extra folders the agent may work in, on top of the user's standard folders. */
  allowedRoots: string[];
  /** Every drive is reachable; system folders become high-risk (ask every time) instead of off-limits. */
  fullDiskAccess: boolean;
  toolGroups: Record<ToolGroup, boolean>;
  toolProtocol: ToolProtocol;
  /** Upper bound on tool calls in one task. */
  maxSteps: number;
  /** The model's context window in tokens: long tasks are compacted before they reach it. */
  contextWindow: number;
  vision: { baseUrl: string; model: string; hasApiKey: boolean };
}

/** Context window presets offered in settings (tokens). */
export const CONTEXT_WINDOWS = [32000, 64000, 128000, 256000, 1000000] as const;
export const DEFAULT_CONTEXT_WINDOW = 64000;

export type ConfirmDecision = 'allow' | 'allow_task' | 'deny';

export interface ConfirmRequest {
  confirmId: string;
  taskId: string;
  tool: string;
  title: string;
  risk: RiskLevel;
  reason: string;
  /** Human-readable lines describing exactly what will happen. */
  preview: string[];
  /** True when the call was proposed after the agent read external content (file / web page / tool output). */
  afterExternalContent: boolean;
  /** "Allow for the rest of this task" is only offered for medium risk. */
  canAllowForTask: boolean;
}

export type StepStatus = 'running' | 'waiting' | 'ok' | 'failed' | 'denied';

export interface AgentStepView {
  stepId: string;
  tool: string;
  title: string;
  status: StepStatus;
  summary?: string;
  verified?: boolean;
}

export interface PlanStepView { title: string; status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped' }

export type AgentPhase = 'thinking' | 'working' | 'asking' | 'success' | 'failure' | 'idle';

export type AgentEvent =
  | { type: 'phase'; requestId: string; phase: AgentPhase; text?: string }
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'interim'; requestId: string; text: string }
  | { type: 'plan'; requestId: string; steps: PlanStepView[] }
  | { type: 'step'; requestId: string; step: AgentStepView }
  | { type: 'confirm'; requestId: string; request: ConfirmRequest }
  | { type: 'confirm-closed'; requestId: string; confirmId: string }
  | { type: 'done'; requestId: string; reply: string; emotion: string; action: string; outcome: 'success' | 'failure' | 'chat' }
  | { type: 'error'; requestId: string; message: string };

/** Signals the agent sends to the pet window so the character reacts. */
export interface AgentPetSignal { agent: AgentPhase; text?: string; progress?: { done: number; total: number } }

export interface MemoryItem { id: string; category: string; text: string; createdAt: string; updatedAt: string }

export interface TaskRecord {
  id: string;
  request: string;
  status: 'running' | 'success' | 'failure' | 'cancelled' | 'chat';
  startedAt: string;
  endedAt?: string;
  toolCalls: number;
  summary?: string;
}

/** Answer to a chat slash command (/help, /resume…). `action` tells the chat what to do next. */
export interface AgentCommandResult { reply: string; action?: 'clear' | 'send'; prompt?: string }

export interface ToolInfo { name: string; group: ToolGroup | 'internal'; risk: RiskLevel; description: string; source: string }

export interface PluginInfo {
  name: string;
  kind: 'local' | 'mcp';
  status: 'loaded' | 'pending-approval' | 'disabled' | 'error';
  detail?: string;
  tools: string[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  /** Risk given to every tool of this server. */
  risk: 'medium' | 'high';
}

export interface SkillSummary { name: string; description: string; source: 'builtin' | 'user' }

/** When a scheduled task runs. */
export type ScheduleTrigger =
  | { kind: 'daily'; time: string }
  | { kind: 'interval'; minutes: number }
  | { kind: 'once'; at: string }
  | { kind: 'folder'; path: string; minFiles: number };

export interface ScheduleInfo {
  id: string;
  name: string;
  prompt: string;
  trigger: ScheduleTrigger;
  /** Human-readable trigger, e.g. "每天 09:00". */
  when: string;
  enabled: boolean;
  lastRunAt?: string;
  lastResult?: string;
  nextRunAt?: string;
}

/** User hooks (hooks.json): none = nothing configured; pending = changed, waiting for approval. */
export interface HooksStatus {
  file: string;
  state: 'none' | 'pending' | 'active' | 'error';
  count: number;
  events: string[];
  detail?: string;
}

export interface AgentInfo {
  schedules: ScheduleInfo[];
  skills: SkillSummary[];
  skillDir: string;
  hooks: HooksStatus;
  /** The user's global instructions file (AGENTS.md in the agent data folder). */
  instructionsFile: string;
  tools: ToolInfo[];
  plugins: PluginInfo[];
  mcpServers: McpServerConfig[];
  memories: MemoryItem[];
  recentTasks: TaskRecord[];
  defaultRoots: string[];
  logDir: string;
  pluginDir: string;
}

/** Operations of the main window's 定时任务 / 技能 pages. */
export type AgentManageOp =
  | { type: 'scheduleCreate'; name: string; prompt: string; trigger: ScheduleTrigger }
  | { type: 'skillRead'; name: string }
  | { type: 'skillSave'; name: string; description: string; body: string }
  | { type: 'skillDelete'; name: string };

export interface AgentManageResult { ok: boolean; error?: string; info?: AgentInfo; text?: string }

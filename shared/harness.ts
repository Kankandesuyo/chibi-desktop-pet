/** Harness types shared by the main process and the chat window (sessions, run stats, trajectory). */

/** Timing and token use of one turn (tokens only when the endpoint reports usage). */
export interface TurnStats {
  steps: number;
  toolCalls: number;
  llmMs: number;
  toolMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface SessionSummary {
  id: string;
  /** The first thing the user said (or "新会话"). */
  title: string;
  /** Last change, ms since epoch. */
  updatedAt: number;
  current: boolean;
}

/** Totals over the current session, as shown in the stats bar. */
export interface SessionStatsView {
  total: { turns: number; steps: number; toolCalls: number; llmMs: number; toolMs: number; inputTokens: number; outputTokens: number; cachedTokens: number; hasTokens: boolean };
  last: TurnStats | null;
}

/** One logged session event as the trajectory view receives it (already redacted). */
export interface TrajectoryEvent {
  seq: number;
  /** ISO time. */
  t: string;
  type: string;
  turnId?: string;
  [key: string]: unknown;
}

/** Chat slash commands (also the autocomplete list in the chat box). */
export const SLASH_COMMANDS: readonly { name: string; aliases: readonly string[]; help: string }[] = [
  { name: 'help', aliases: ['帮助'], help: '看看有哪些命令' },
  { name: 'new', aliases: ['clear'], help: '开始新会话（之前的会话留在左边列表里）' },
  { name: 'resume', aliases: ['继续'], help: '接着做上一个没做完的任务' },
  { name: 'status', aliases: ['状态'], help: '看看当前会话和她的状态' },
  { name: 'tools', aliases: ['工具'], help: '看看她现在能用哪些工具' },
  { name: 'skills', aliases: ['技能'], help: '看看她会哪些技能（内置的和你教的）' },
  { name: 'permissions', aliases: ['权限'], help: '看看当前的权限模式和规则' },
  { name: 'hooks', aliases: ['钩子'], help: '看看钩子（hooks.json）的状态' },
];

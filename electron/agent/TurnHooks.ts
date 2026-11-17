import type { ChatMessage } from '../../shared/types';
import type { LlmMessage } from './llm';
import type { TurnEndReason, TurnOutcome, TurnStats } from './SessionStore';
import type { RecapStep } from './TaskRecap';
import type { ExecutionRecord, TaskRuntime } from './ToolExecutor';

/**
 * Lifecycle events of one agent turn (after DeepSeek Harness's agent loop events). A turn is one user
 * request; a step is one model call plus the tools it asked for. Features such as session logging,
 * cross-turn recaps and context compaction are listeners here instead of code inside the loop.
 *
 *   turn/start → [ step/pre → (model) → assistant/message → tool/pre … tool/post ]* → turn/end
 */

export interface TurnContext {
  readonly turnId: string;
  readonly userText: string;
  /** The recent chat history this turn was started with. */
  readonly history: ChatMessage[];
  readonly rt: TaskRuntime;
  /** Extra system-prompt blocks; only turn/start listeners should add to it. */
  readonly systemSections: string[];
  /** The conversation sent to the model (filled in after turn/start). step/pre may shrink it. */
  messages: LlmMessage[];
  step: number;
  /** Per-turn scratch space for listeners. */
  readonly state: Map<string, unknown>;
}

export interface ToolCallInfo { id: string; name: string; arguments: string | Record<string, unknown>; title: string }

export interface ToolOutcome {
  call: ToolCallInfo;
  /** null when the call never reached the executor (malformed, or blocked by a tool/pre guard). */
  rec: ExecutionRecord | null;
  /** Redacted one-line view of the result (what recaps and the session log keep). */
  view: RecapStep;
  /** The message added to the conversation, and its short form for compaction. */
  resultMessage: LlmMessage;
  short: string | null;
}

export interface TurnEnd { reason: TurnEndReason; outcome: TurnOutcome; reply?: string; error?: string; stats?: TurnStats }

export interface TurnHookMap {
  'turn/start': (ctx: TurnContext) => void | Promise<void>;
  'step/pre': (ctx: TurnContext) => void | Promise<void>;
  'assistant/message': (ctx: TurnContext, msg: { text: string; calls: ToolCallInfo[] }) => void | Promise<void>;
  /** Guard: return { deny } to block the call. The first denial wins and later listeners cannot undo it. */
  'tool/pre': (ctx: TurnContext, call: ToolCallInfo) => void | { deny: string } | Promise<void | { deny: string }>;
  'tool/post': (ctx: TurnContext, out: ToolOutcome) => void | Promise<void>;
  'turn/end': (ctx: TurnContext, end: TurnEnd) => void | Promise<void>;
}

type Listener<K extends keyof TurnHookMap> = { name: string; fn: TurnHookMap[K] };

export class TurnHooks {
  private readonly listeners: { [K in keyof TurnHookMap]: Listener<K>[] } = {
    'turn/start': [], 'step/pre': [], 'assistant/message': [], 'tool/pre': [], 'tool/post': [], 'turn/end': [],
  };

  /** Registers a listener; returns a function that removes it. `name` shows up in error logs. */
  on<K extends keyof TurnHookMap>(event: K, name: string, fn: TurnHookMap[K]): () => void {
    const entry = { name, fn } as Listener<K>;
    (this.listeners[event] as Listener<K>[]).push(entry);
    return () => {
      const list = this.listeners[event] as Listener<K>[];
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Runs listeners in order. A failing listener is logged and skipped: features must not break the turn. */
  async emit<K extends Exclude<keyof TurnHookMap, 'tool/pre'>>(event: K, ...args: Parameters<TurnHookMap[K]>): Promise<void> {
    for (const l of [...this.listeners[event]] as Listener<K>[]) {
      try { await (l.fn as (...a: unknown[]) => unknown)(...args); } catch (err) { console.error(`[hooks] ${event} listener "${l.name}" failed`, err); }
    }
  }

  /** tool/pre: null = may run, string = why it was blocked. A guard that throws blocks the call (fail closed). */
  async guard(ctx: TurnContext, call: ToolCallInfo): Promise<string | null> {
    for (const l of [...this.listeners['tool/pre']]) {
      try {
        const r = await l.fn(ctx, call);
        if (r && typeof r === 'object' && typeof r.deny === 'string') return r.deny || `被 ${l.name} 拦下了`;
      } catch (err) {
        return `检查这一步时出错（${l.name}）：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return null;
  }
}

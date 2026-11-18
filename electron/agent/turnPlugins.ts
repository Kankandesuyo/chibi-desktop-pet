import { ContextCompactor, type CompactOptions } from './ContextCompactor';
import type { SessionStore } from './SessionStore';
import { formatRecaps, formatResume, type RecapStep, type TaskRecaps } from './TaskRecap';
import type { TaskLogger } from './TaskLogger';
import type { TurnHooks } from './TurnHooks';
import type { ToolRegistry } from './ToolRegistry';

/**
 * The built-in turn plugins. Each one only listens to TurnHooks events, so it can be removed or replaced
 * without touching the loop.
 */

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Writes every turn to the session log (redacted, clipped). */
export function sessionLogPlugin(hooks: TurnHooks, store: SessionStore, redact: (s: string) => string): () => void {
  const offs = [
    hooks.on('turn/start', 'session-log', (ctx) => { store.append({ type: 'turn/start', turnId: ctx.turnId, userText: clip(redact(ctx.userText), 4000) }); }),
    hooks.on('step/pre', 'session-log', (ctx) => { store.append({ type: 'step/start', turnId: ctx.turnId, step: ctx.step }); }),
    hooks.on('assistant/message', 'session-log', (ctx, msg) => {
      store.append({
        type: 'assistant/message', turnId: ctx.turnId, text: clip(redact(msg.text), 2000),
        calls: msg.calls.map((c) => ({ id: c.id, name: c.name, args: clip(redact(typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments)), 500) })),
      });
    }),
    hooks.on('tool/post', 'session-log', (ctx, out) => {
      if (out.call.name === 'update_plan') return;
      store.append({ type: 'tool/result', turnId: ctx.turnId, callId: out.call.id, name: out.call.name, result: out.view });
    }),
    hooks.on('turn/end', 'session-log', (ctx, end) => {
      store.append({ type: 'turn/end', turnId: ctx.turnId, reason: end.reason, outcome: end.outcome, ...(end.reply ? { reply: clip(redact(end.reply), 1000) } : {}), ...(end.stats ? { stats: end.stats } : {}) });
      store.rotateIfLarge();
    }),
  ];
  return () => { for (const off of offs) off(); };
}

/**
 * Carries what earlier turns really did into follow-ups (see TaskRecap), and a task picked up again with
 * /resume. Carried file/web content counts as external, so medium-risk auto-approval stays off.
 */
export function recapPlugin(hooks: TurnHooks, recaps: TaskRecaps, store: SessionStore): () => void {
  const STEPS = 'recap.steps';
  const offs = [
    hooks.on('turn/start', 'recap', (ctx) => {
      const recap = formatRecaps(recaps.forHistory(ctx.history));
      const resume = store.takePendingResume();
      const resumed = resume && resume.reason ? formatResume({ userText: resume.userText, outcome: resume.outcome ?? 'failure', steps: resume.steps, reason: resume.reason }) : null;
      if (recap) ctx.systemSections.push(recap.text);
      if (resumed) ctx.systemSections.push(resumed.text);
      if (recap?.external || resumed?.external) ctx.rt.tainted = true;
      ctx.state.set(STEPS, []);
    }),
    hooks.on('tool/post', 'recap', (ctx, out) => {
      if (out.call.name !== 'update_plan') (ctx.state.get(STEPS) as RecapStep[] | undefined)?.push(out.view);
    }),
    hooks.on('turn/end', 'recap', (ctx, end) => {
      // Even a failed or cancelled turn may have changed things; the next one should know what.
      recaps.add({ userText: ctx.userText, outcome: end.outcome, steps: (ctx.state.get(STEPS) as RecapStep[] | undefined) ?? [] });
    }),
  ];
  return () => { for (const off of offs) off(); };
}

/** Keeps one turn's conversation inside the size budget (see ContextCompactor). */
export function compactionPlugin(hooks: TurnHooks, options: () => CompactOptions, logger: TaskLogger, store: SessionStore): () => void {
  const KEY = 'compaction.compactor';
  const get = (state: Map<string, unknown>): ContextCompactor => {
    let c = state.get(KEY) as ContextCompactor | undefined;
    if (!c) { c = new ContextCompactor(options()); state.set(KEY, c); }
    return c;
  };
  const offs = [
    hooks.on('step/pre', 'compaction', (ctx) => {
      const saved = get(ctx.state).compact(ctx.messages);
      if (saved > 0) {
        logger.log(ctx.turnId, 'context_compacted', { savedChars: saved, iteration: ctx.step });
        store.append({ type: 'compaction', turnId: ctx.turnId, savedChars: saved });
      }
    }),
    hooks.on('tool/post', 'compaction', (ctx, out) => { if (out.short !== null) get(ctx.state).registerResult(out.resultMessage, out.short); }),
  ];
  return () => { for (const off of offs) off(); };
}

/** Rebuilds the in-memory recaps from the session log (so follow-ups still work after a restart). */
export function replayRecaps(recaps: TaskRecaps, store: SessionStore, last = 5): void {
  for (const t of store.turns().slice(-last)) recaps.add({ userText: t.userText, outcome: t.outcome ?? 'cancelled', steps: t.steps });
}

/** Tools besides the concurrency-safe lookups that only read (allowed in read-only mode). */
const READ_ONLY_EXTRA = new Set(['read_file', 'update_plan', 'read_process_output', 'browser_tabs']);

/**
 * Read-only mode (a tool/pre guard): she may look around and plan, but nothing that changes the computer
 * runs. Plugin and MCP tools are blocked too, since their side effects are unknown.
 */
export function readOnlyPlugin(hooks: TurnHooks, registry: ToolRegistry, readOnly: () => boolean): () => void {
  const offs = [
    hooks.on('turn/start', 'read-only-mode', (ctx) => {
      if (readOnly() && !ctx.state.get('run.unattended')) ctx.systemSections.push('## 当前是只读模式\n用户选择了只读模式：你只能用查看类工具（列目录、搜索、读文件、查进程等）了解情况，不能新建、移动、删除、运行或修改任何东西。需要改动时，把具体步骤列给用户，请用户切换到“询问”模式后再做。');
    }),
    hooks.on('tool/pre', 'read-only-mode', (ctx, call) => {
      // The setting, or this run only (scheduled tasks run read-only).
      if (!readOnly() && !ctx.state.get('run.readOnly')) return undefined;
      const tool = registry.get(call.name);
      const builtin = !tool?.source || tool.source === 'builtin';
      if (tool && builtin && (tool.concurrencySafe || READ_ONLY_EXTRA.has(tool.name))) return undefined;
      return { deny: '现在是只读模式：只能查看，不能修改电脑。请把要做的步骤告诉用户，等用户切换到“询问”模式后再做。' };
    }),
  ];
  return () => { for (const off of offs) off(); };
}

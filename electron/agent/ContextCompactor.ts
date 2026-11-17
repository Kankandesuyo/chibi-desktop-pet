import type { LlmMessage } from './llm';

/**
 * Keeps one task's conversation inside a size budget. A long task (25 steps × up to 12k characters of
 * tool output) would otherwise overflow the model's context or get slow and expensive.
 *
 * Only the tool side is shrunk, oldest first, and the most recent results are always kept whole:
 *  1. old tool results → their short form (ok / summary / error, "details omitted, query again if needed")
 *  2. old, very long tool-call arguments (e.g. file contents already written) → long strings clipped
 * The system prompt and the user's own messages are never touched.
 */

export interface CompactOptions {
  /** Start compacting above this many characters in total. */
  maxChars: number;
  /** The newest N tool results stay complete. */
  keepRecentResults: number;
  /** Tool-call arguments longer than this are clipped (outside the newest N). */
  maxArgChars: number;
}

export const DEFAULT_COMPACT: CompactOptions = { maxChars: 80_000, keepRecentResults: 4, maxArgChars: 1500 };

const CLIP_STRING = 200;

export function messageChars(m: LlmMessage): number {
  let n = typeof m.content === 'string' ? m.content.length
    : Array.isArray(m.content) ? m.content.reduce((s, p) => s + (p.type === 'text' ? p.text.length : 1000), 0) : 0;
  if (m.role === 'assistant') {
    for (const c of m.tool_calls ?? []) n += c.function.arguments.length + c.function.name.length;
    n += m.reasoning_content?.length ?? 0;
  }
  return n;
}

export const totalChars = (messages: LlmMessage[]): number => messages.reduce((s, m) => s + messageChars(m), 0);

/** Long string values inside a JSON argument object get clipped; the result is still valid JSON. */
export function clipArguments(args: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(args); } catch { return null; }
  const clip = (v: unknown): unknown => {
    if (typeof v === 'string') return v.length > CLIP_STRING ? `${v.slice(0, CLIP_STRING)}…（已省略 ${v.length - CLIP_STRING} 字）` : v;
    if (Array.isArray(v)) return v.length > 20 ? [...v.slice(0, 20).map(clip), `…（还有 ${v.length - 20} 项已省略）`] : v.map(clip);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
    return v;
  };
  return JSON.stringify(clip(parsed));
}

export class ContextCompactor {
  /** Short replacement for each tool-result message, registered when the result was added. */
  private readonly shortForms = new WeakMap<LlmMessage, string>();

  constructor(private readonly opts: CompactOptions = DEFAULT_COMPACT) {}

  registerResult(message: LlmMessage, short: string): void { this.shortForms.set(message, short); }

  /** Shrinks `messages` in place if over budget. Returns how many characters were saved (0 = untouched). */
  compact(messages: LlmMessage[]): number {
    const before = totalChars(messages);
    if (before <= this.opts.maxChars) return 0;
    let total = before;

    const results = messages.filter((m) => this.shortForms.has(m));
    const oldResults = results.slice(0, Math.max(0, results.length - this.opts.keepRecentResults));
    // Messages from the newest kept result onward are "recent": their arguments stay intact too.
    const firstRecent = results.length > this.opts.keepRecentResults ? messages.indexOf(results[results.length - this.opts.keepRecentResults] as LlmMessage) : 0;

    for (const m of oldResults) {
      if (total <= this.opts.maxChars) break;
      const short = this.shortForms.get(m) as string;
      if (typeof m.content !== 'string' || m.content.length <= short.length) continue;
      total -= m.content.length - short.length;
      m.content = short;
      this.shortForms.delete(m);                             // already as small as it gets
    }

    for (let i = 0; i < firstRecent && total > this.opts.maxChars; i++) {
      const m = messages[i] as LlmMessage;
      if (m.role !== 'assistant') continue;
      for (const c of m.tool_calls ?? []) {
        if (c.function.arguments.length <= this.opts.maxArgChars) continue;
        const clipped = clipArguments(c.function.arguments);
        if (clipped === null || clipped.length >= c.function.arguments.length) continue;
        total -= c.function.arguments.length - clipped.length;
        c.function.arguments = clipped;
      }
      // Text protocol: the call lives in the content.
      if (!m.tool_calls && typeof m.content === 'string' && m.content.length > this.opts.maxArgChars) {
        const short = `${m.content.slice(0, 300)}…（这一步的完整调用内容已省略）`;
        total -= m.content.length - short.length;
        m.content = short;
      }
    }
    return before - total;
  }
}

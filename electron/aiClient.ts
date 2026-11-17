import { buildSystemPrompt, parseAiReply } from '../shared/aiProtocol';
import type { AiReplyMeta, ChatMessage, PetStats } from '../shared/types';

export interface AiRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  stats: PetStats;
  /** Persona block (name, personality, inner state). */
  persona?: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

const TIMEOUT_MS = 60_000;

export function normalizeBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Pulls the text deltas out of an OpenAI-style SSE stream. `feed` returns the deltas found in a chunk. */
export function createSseParser(): { feed: (chunk: string) => string[]; done: () => boolean } {
  let buffer = '';
  let finished = false;
  return {
    feed(chunk: string): string[] {
      buffer += chunk;
      const out: string[] = [];
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { finished = true; continue; }
        try {
          const json = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) out.push(delta);
        } catch { /* ignore keep-alives and malformed lines */ }
      }
      return out;
    },
    done: () => finished,
  };
}

/** Streams one chat completion from an OpenAI-compatible endpoint. Throws a readable Error on failure. */
export async function streamChat(req: AiRequest): Promise<AiReplyMeta> {
  const base = normalizeBaseUrl(req.baseUrl);
  if (!base) throw new Error('Base URL 无效，需要以 http(s):// 开头');
  if (!req.apiKey) throw new Error('还没有填写 API Key');

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([req.signal, timeout]);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        temperature: 0.8,
        max_tokens: 300,
        messages: [{ role: 'system', content: buildSystemPrompt(req.stats, req.persona) }, ...req.messages.slice(-16)],
      }),
      signal,
    });
  } catch (err) {
    if (req.signal.aborted) throw new Error('已取消');
    if (timeout.aborted) throw new Error('请求超时');
    throw new Error(`连接失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}${body ? `：${body.slice(0, 160)}` : ''}`);
  }

  const parser = createSseParser();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let full = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const delta of parser.feed(decoder.decode(value, { stream: true }))) {
        full += delta;
        req.onDelta(delta);
      }
      if (parser.done()) break;
    }
  } catch (err) {
    if (req.signal.aborted) throw new Error('已取消');
    throw new Error(`读取回复中断：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (!full.trim()) throw new Error('接口没有返回内容');
  return parseAiReply(full);
}

/** One short non-streaming completion with no tools (used for her self-talk). */
export async function completeOnce(o: { baseUrl: string; apiKey: string; model: string; system: string; signal: AbortSignal }): Promise<string> {
  const base = normalizeBaseUrl(o.baseUrl);
  if (!base || !o.apiKey) throw new Error('AI 未配置');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}` },
    body: JSON.stringify({
      model: o.model, stream: false, temperature: 1, max_tokens: 80,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: '（自言自语一句）' }],
    }),
    signal: AbortSignal.any([o.signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (!res.ok) throw new Error(`接口返回 ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('接口没有返回内容');
  return text;
}

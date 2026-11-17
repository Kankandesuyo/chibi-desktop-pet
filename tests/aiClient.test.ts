import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSseParser, normalizeBaseUrl, streamChat } from '../electron/aiClient';

const stats = { mood: 'neutral', affection: 30, energy: 80, interactionCount: 0 } as const;
let server: http.Server;
let base = '';
let lastAuth = '';
let lastBody: { model?: string; stream?: boolean; messages?: { role: string }[] } = {};

/** A tiny OpenAI-compatible endpoint that streams a fixed answer in several SSE chunks. */
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      lastAuth = req.headers.authorization ?? '';
      lastBody = JSON.parse(raw);
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const parts = ['今天', '也要加油呀！', '[[emotion:ha', 'ppy|action:wave]]'];
        // deliberately split one SSE line across two network chunks
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[0] } }] })}\n\nda`);
        res.write(`ta: ${JSON.stringify({ choices: [{ delta: { content: parts[1] } }] })}\n\n: keep-alive\n\n`);
        for (const p of parts.slice(2)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else if (req.url === '/slow/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '嗯' } }] })}\n\n`);   // then never finishes
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"bad key"}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

describe('AI client (OpenAI-compatible, streaming)', () => {
  it('streams deltas and returns a validated reply', async () => {
    const deltas: string[] = [];
    const result = await streamChat({
      baseUrl: `${base}/v1/`, apiKey: 'sk-test', model: 'm', stats, signal: new AbortController().signal,
      messages: [{ role: 'user', content: '你好' }], onDelta: (t) => deltas.push(t),
    });
    expect(deltas.length).toBe(4);
    expect(result).toEqual({ reply: '今天也要加油呀！', emotion: 'happy', action: 'wave' });
    expect(lastAuth).toBe('Bearer sk-test');
    expect(lastBody.stream).toBe(true);
    expect(lastBody.messages?.[0]?.role).toBe('system');
  });

  it('turns an HTTP error into a readable message instead of crashing', async () => {
    await expect(streamChat({
      baseUrl: `${base}/nope`, apiKey: 'x', model: 'm', stats, signal: new AbortController().signal, messages: [], onDelta: () => undefined,
    })).rejects.toThrow(/401/);
  });

  it('reports an unreachable server', async () => {
    await expect(streamChat({
      baseUrl: 'http://127.0.0.1:9', apiKey: 'x', model: 'm', stats, signal: new AbortController().signal, messages: [], onDelta: () => undefined,
    })).rejects.toThrow(/连接失败/);
  });

  it('can be cancelled mid-stream', async () => {
    const ac = new AbortController();
    const p = streamChat({
      baseUrl: `${base}/slow`, apiKey: 'x', model: 'm', stats, signal: ac.signal, messages: [], onDelta: () => ac.abort(),
    });
    await expect(p).rejects.toThrow(/已取消/);
  });

  it('refuses missing keys and non-http URLs before sending anything', async () => {
    const common = { model: 'm', stats, signal: new AbortController().signal, messages: [], onDelta: () => undefined };
    await expect(streamChat({ ...common, baseUrl: base, apiKey: '' })).rejects.toThrow(/API Key/);
    await expect(streamChat({ ...common, baseUrl: 'file:///etc/passwd', apiKey: 'x' })).rejects.toThrow(/Base URL/);
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull();
  });

  it('SSE parser ignores junk lines', () => {
    const p = createSseParser();
    expect(p.feed('event: ping\ndata: not json\ndata: {"choices":[{"delta":{}}]}\n')).toEqual([]);
    expect(p.feed('data: [DONE]\n')).toEqual([]);
    expect(p.done()).toBe(true);
  });
});

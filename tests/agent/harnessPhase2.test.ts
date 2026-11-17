/**
 * Harness phase 2: the session log as the one source of the conversation (list / switch / import),
 * read-only mode, token usage and turn stats.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTurnParser, OpenAiCompatibleClient } from '../../electron/agent/llm';
import { SessionStore, type LoggedEvent } from '../../electron/agent/SessionStore';
import { TaskRecaps } from '../../electron/agent/TaskRecap';
import { createSessionConversation } from '../../electron/sessionConversation';
import { call, FakePlatform, finalSteps, lastToolResult, makeHarness, say, type Harness } from './helpers';

let h: Harness | undefined;
let platform: FakePlatform | undefined;
afterEach(() => { h?.cleanup(); h = undefined; platform?.cleanup(); platform = undefined; });
const tmpStore = (): SessionStore => { platform = new FakePlatform(); return new SessionStore(path.join(platform.root, 'sessions')); };

describe('sessions as the conversation', () => {
  it('keeps chat messages in the log; list, switch and titles', async () => {
    const s = tmpStore();
    const first = s.id;
    s.addChat({ id: 'u1', role: 'user', content: '帮我整理下载文件夹' });
    s.addChat({ id: 'a1', role: 'assistant', content: '整理好了' });
    await new Promise((r) => setTimeout(r, 1100));          // ids are per second
    let switched = 0;
    s.onSwitch(() => { switched++; });
    const second = s.newSession();
    expect(s.chat()).toEqual([]);
    s.addChat({ id: 'u2', role: 'user', content: '打开 VS Code' });
    const list = s.list();
    expect(list.map((x) => x.id)).toEqual([second, first]);
    expect(list[0]).toMatchObject({ title: '打开 VS Code', current: true });
    expect(list[1]).toMatchObject({ title: '帮我整理下载文件夹', current: false });
    expect(s.switchTo(first)).toBe(true);
    expect(s.chat().map((m) => m.content)).toEqual(['帮我整理下载文件夹', '整理好了']);
    expect(switched).toBe(2);
    expect(s.switchTo('../../etc/passwd')).toBe(false);
    expect(s.switchTo('20990101-000000-zzzz')).toBe(false);
    // Reopening from disk gives the same conversation.
    const again = new SessionStore(s.dir);
    expect(again.chat().map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('imports the old shared history once, then clear starts a new session', () => {
    const s = tmpStore();
    const legacy = path.join(platform!.root, 'shared-history.json');
    fs.writeFileSync(legacy, JSON.stringify({ schema: 2, messages: [{ role: 'user', content: '旧消息' }, { role: 'assistant', content: '旧回复', id: 'x' }, { role: 'system', content: 'junk' }] }));
    const recaps = new TaskRecaps();
    recaps.add({ userText: '旧消息', outcome: 'success', steps: [{ title: 't', status: 'ok', summary: 's', external: false }] });
    let mirrored: unknown[] = [];
    const conv = createSessionConversation({ sessions: s, recaps, legacyHistoryFile: legacy, setChatHistory: (h) => { mirrored = h; } })(() => undefined);
    expect(conv.messages.map((m) => m.content)).toEqual(['旧消息', '旧回复']);
    // Not again on the next start.
    createSessionConversation({ sessions: new SessionStore(s.dir), recaps, legacyHistoryFile: legacy });
    expect(new SessionStore(s.dir).chat()).toHaveLength(2);
    conv.append({ role: 'user', content: '新的' });
    expect(mirrored).toHaveLength(3);
    const before = s.id;
    conv.clear();
    expect(s.id).not.toBe(before);
    expect(conv.messages).toEqual([]);
    expect(recaps.forHistory([{ role: 'user', content: '旧消息' }, { role: 'user', content: 'x' }])).toEqual([]);
  });

  it('imports the desktop history from config when there is no shared history', () => {
    const s = tmpStore();
    createSessionConversation({ sessions: s, recaps: new TaskRecaps(), legacyHistoryFile: path.join(platform!.root, 'nope.json'), legacyDesktopHistory: () => [{ role: 'user', content: '桌面旧消息' }] });
    expect(s.chat().map((m) => m.content)).toEqual(['桌面旧消息']);
  });
});

describe('read-only mode', () => {
  it('lets her look but not change anything, and tells the model up front', async () => {
    h = makeHarness([], { settings: { readOnly: true } });
    h.llm.push(
      call('list_directory', { path: h.platform.folders.desktop }),
      call('create_directory', { path: '~/Desktop/只读不能建' }),
      (m) => { expect(String(lastToolResult(m).error)).toContain('只读模式'); return say('现在是只读模式，我没有建。'); },
    );
    const r = await h.run('看看桌面，再建个文件夹');
    expect(finalSteps(r).map((s) => s.status)).toEqual(['ok', 'denied']);
    expect(fs.existsSync(path.join(h.platform.folders.desktop, '只读不能建'))).toBe(false);
    expect(String(h.llm.requests[0]?.messages[0]?.content)).toContain('当前是只读模式');
  });

  it('is off by default', async () => {
    h = makeHarness([call('create_directory', { path: '~/Desktop/可以建' }), say('好')]);
    await h.run('建');
    expect(fs.existsSync(path.join(h.platform.folders.desktop, '可以建'))).toBe(true);
  });
});

describe('usage and stats', () => {
  it('reads streamed usage (incl. DeepSeek cache hits) from the final chunk', () => {
    const p = createTurnParser();
    p.feed(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n`);
    p.feed(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_cache_hit_tokens: 900 } })}\n`);
    p.feed('data: [DONE]\n');
    expect(p.finish().usage).toEqual({ input: 1200, output: 30, cached: 900 });
  });

  it('records steps, timing and tokens in turn/end', async () => {
    h = makeHarness([
      { ...call('get_known_folders', {}), usage: { input: 1000, output: 20, cached: 600 } },
      { content: '好', toolCalls: [], finishReason: 'stop', reasoning: '', usage: { input: 1100, output: 10 } },
    ]);
    await h.run('桌面在哪');
    const end = h.rt.sessions.events().find((e) => e.type === 'turn/end') as Extract<LoggedEvent, { type: 'turn/end' }>;
    expect(end.stats).toMatchObject({ steps: 2, toolCalls: 1, inputTokens: 2100, outputTokens: 30, cachedTokens: 600 });
    expect(h.rt.sessions.turns()[0]?.stats?.steps).toBe(2);
  });
});

describe('stream_options fallback', () => {
  let server: http.Server; let base = ''; const bodies: Record<string, unknown>[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>; bodies.push(body);
        if (body.stream_options) { res.writeHead(400); res.end('{"error":"unknown field stream_options"}'); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });

  it('retries without stream_options and remembers it', async () => {
    const client = new OpenAiCompatibleClient(() => ({ baseUrl: base, apiKey: 'k', model: 'm' }));
    const req = { messages: [{ role: 'user' as const, content: 'hi' }], signal: new AbortController().signal };
    expect((await client.complete(req)).content).toBe('ok');
    expect((await client.complete(req)).content).toBe('ok');
    expect(bodies.map((b) => 'stream_options' in b)).toEqual([true, false, false]);
  });
});

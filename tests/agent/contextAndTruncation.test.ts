/**
 * P0 fixes: (1) output-length truncation never runs half-written tool calls, and tool turns get room;
 * (2) what earlier tasks really did is carried into follow-up requests (and dropped when the chat is cleared).
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { maxTokensLimitFrom, OpenAiCompatibleClient, TOOL_TURN_MAX_TOKENS, type LlmMessage, type LlmTurn } from '../../electron/agent/llm';
import type { ChatMessage } from '../../shared/types';
import { call, finalSteps, lastToolResult, makeHarness, say, type Harness } from './helpers';

let h: Harness;
afterEach(() => h?.cleanup());

const cut = (name: string, partialArgs: string): LlmTurn =>
  ({ content: '', toolCalls: [{ id: 'call_cut', type: 'function', function: { name, arguments: partialArgs } }], finishReason: 'length', reasoning: '' });
const systemText = (m: LlmMessage[] | undefined): string => String(m?.[0]?.content ?? '');

describe('output-length truncation', () => {
  it('gives tool turns a bigger output budget', async () => {
    h = makeHarness([say('你好')]);
    await h.run('嗨');
    expect(h.llm.requests[0]?.maxTokens).toBe(TOOL_TURN_MAX_TOKENS);
  });

  it('never runs a tool call whose arguments were cut off, and tells the model to split the work', async () => {
    h = makeHarness();
    const file = path.join(h.platform.folders.desktop, 'long.txt');
    h.llm.push(
      cut('write_file', JSON.stringify({ path: file, content: 'x'.repeat(50) }).slice(0, 40)),
      (m) => {
        expect(String(lastToolResult(m).error)).toContain('输出长度上限');
        // The broken arguments are not echoed back to the endpoint.
        const assistant = m.find((x) => x.role === 'assistant' && 'tool_calls' in x && x.tool_calls);
        expect(assistant && 'tool_calls' in assistant ? assistant.tool_calls?.[0]?.function.arguments : null).toBe('{}');
        return say('文件太长了，我分几次写。');
      },
    );
    const r = await h.run('写个长文件');
    expect(fs.existsSync(file)).toBe(false);
    expect(r.confirms).toHaveLength(0);
    expect(finalSteps(r)[0]?.status).toBe('failed');
  });

  it('still runs complete calls from a truncated turn', async () => {
    h = makeHarness([
      { content: '', finishReason: 'length', reasoning: '', toolCalls: [
        { id: 'a', type: 'function', function: { name: 'get_known_folders', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'create_directory', arguments: '{"path":"~/Desk' } },
      ] },
      say('好'),
    ]);
    const r = await h.run('看看');
    expect(finalSteps(r).map((s) => s.status)).toEqual(['ok', 'failed']);
  });

  it('marks a final reply that hit the limit', async () => {
    h = makeHarness([{ content: '很长很长的回答', toolCalls: [], finishReason: 'length', reasoning: '' }]);
    const r = await h.run('讲个故事');
    expect(r.done?.reply).toContain('被截断');
  });

  it('explains truncation in the JSON text protocol too', async () => {
    h = makeHarness([
      { content: '<tool_call>{"name":"write_file","arguments":{"path":"a.txt","content":"xx', toolCalls: [], finishReason: 'length', reasoning: '' },
      (m) => { expect(String(m[m.length - 1]?.content)).toContain('输出长度上限'); return say('好'); },
    ], { settings: { toolProtocol: 'json' } });
    await h.run('写');
  });
});

describe('max_tokens limit parsing', () => {
  it('reads the stated limit, or halves', () => {
    expect(maxTokensLimitFrom('max_tokens is too large: 8192. This model supports at most 4096 completion tokens', 8192)).toBe(4096);
    expect(maxTokensLimitFrom('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]', 16384)).toBe(8192);
    expect(maxTokensLimitFrom('max_tokens too big', 8192)).toBe(4096);
    expect(maxTokensLimitFrom('model not found', 8192)).toBeNull();
    expect(maxTokensLimitFrom('max_tokens too big', 1500)).toBeNull();
  });
});

describe('client retries a rejected max_tokens once and remembers the cap', () => {
  let server: http.Server; let base = ''; const seen: number[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw) as { max_tokens: number }; seen.push(body.max_tokens);
        if (body.max_tokens > 4096) { res.writeHead(400); res.end('{"error":{"message":"max_tokens is too large. This model supports at most 4096 completion tokens"}}'); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });

  it('works', async () => {
    const client = new OpenAiCompatibleClient(() => ({ baseUrl: base, apiKey: 'k', model: 'm' }));
    const req = { messages: [{ role: 'user' as const, content: 'hi' }], signal: new AbortController().signal, maxTokens: 8192 };
    expect((await client.complete(req)).content).toBe('ok');
    expect((await client.complete(req)).content).toBe('ok');
    expect(seen).toEqual([8192, 4096, 4096]);
  });
});

describe('cross-turn task context', () => {
  it('tells a follow-up request what the previous task really did', async () => {
    h = makeHarness();
    const dir = path.join(h.platform.folders.desktop, '季度报告');
    h.llm.push(call('create_directory', { path: dir }), say('建好啦'));
    await h.run('在桌面建个季度报告文件夹');

    const history: ChatMessage[] = [{ role: 'user', content: '在桌面建个季度报告文件夹' }, { role: 'assistant', content: '建好啦' }];
    h.llm.push(say('好'));
    await h.run('把它打开', { history });
    const sys = systemText(h.llm.requests[h.llm.requests.length - 1]?.messages);
    expect(sys).toContain('之前几次任务真实做过的事');
    expect(sys).toContain(dir);
    expect(sys).toContain('<untrusted_data source="task_recap">');
  });

  it('forgets once the request is no longer in the history (chat cleared)', async () => {
    h = makeHarness([call('get_known_folders', {}), say('好'), say('嗯')]);
    await h.run('桌面在哪');
    await h.run('你好');                                      // empty history: like a cleared chat
    expect(systemText(h.llm.requests[2]?.messages)).not.toContain('之前几次任务');
  });

  it('plain chat leaves no recap', async () => {
    h = makeHarness([say('你好呀'), say('嗯')]);
    await h.run('你好');
    await h.run('再说一遍', { history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }] });
    expect(systemText(h.llm.requests[1]?.messages)).not.toContain('之前几次任务');
  });

  it('carried file content keeps auto-approval off, and secrets stay hidden', async () => {
    h = makeHarness([], { settings: { autoApproveMedium: true } });
    const note = path.join(h.platform.folders.documents, 'note.txt');
    fs.writeFileSync(note, '配置 sk-abcdefghijklmnopqrstuvwxyz123456 不要外传');
    h.llm.push(call('read_file', { path: note }), say('读完了'));
    await h.run('读一下 note');

    h.llm.push(call('create_directory', { path: '~/Desktop/新文件夹' }), say('好'));
    const r = await h.run('建个文件夹', { history: [{ role: 'user', content: '读一下 note' }, { role: 'assistant', content: '读完了' }] });
    expect(r.confirms).toHaveLength(1);                     // would have been auto-approved without the carried data
    const sys = systemText(h.llm.requests[h.llm.requests.length - 2]?.messages);
    expect(sys).toContain('note.txt');
    expect(sys).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('records failed and denied steps too', async () => {
    h = makeHarness([call('create_directory', { path: '~/Desktop/不许建' }), say('没建')]);
    await h.run('建个文件夹', { decide: () => 'deny' });
    h.llm.push(say('嗯'));
    await h.run('为什么', { history: [{ role: 'user', content: '建个文件夹' }, { role: 'assistant', content: '没建' }] });
    expect(systemText(h.llm.requests[h.llm.requests.length - 1]?.messages)).toContain('被拒绝');
  });
});

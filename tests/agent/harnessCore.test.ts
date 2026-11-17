/**
 * Harness phase 1: event-sourced sessions (with crash repair and /resume), turn lifecycle hooks,
 * parallel read-only tools, and slash commands.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../electron/agent/commands';
import { foldTurns, SessionStore, type LoggedEvent } from '../../electron/agent/SessionStore';
import { defineTool } from '../../electron/agent/types';
import type { LlmMessage } from '../../electron/agent/llm';
import { call, calls, FakePlatform, finalSteps, lastToolResult, makeHarness, say, type Harness } from './helpers';

let h: Harness | undefined;
let h2: Harness | undefined;
afterEach(() => { h2?.cleanup(); h2 = undefined; h?.cleanup(); h = undefined; });

const sessionEvents = (baseDir: string): LoggedEvent[] => {
  const dir = path.join(baseDir, 'sessions');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LoggedEvent));
};
const systemText = (m: LlmMessage[] | undefined): string => String(m?.[0]?.content ?? '');
const cmd = (x: Harness, text: string) => runCommand(text, { controller: x.rt.controller, sessions: x.rt.sessions, recaps: x.rt.recaps, registry: x.rt.registry });

describe('session log', () => {
  it('records a turn as typed events, redacted', async () => {
    h = makeHarness([call('create_directory', { path: '~/Desktop/日志测试' }), say('建好了 sk-abcdefghijklmnopqrstuvwxyz123456')]);
    await h.run('建个文件夹，密码: hunter22');
    const types = sessionEvents(h.baseDir).map((e) => e.type);
    expect(types).toEqual(['session/start', 'turn/start', 'step/start', 'assistant/message', 'tool/result', 'step/start', 'turn/end']);
    const all = JSON.stringify(sessionEvents(h.baseDir));
    expect(all).not.toContain('hunter22');
    expect(all).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    const end = sessionEvents(h.baseDir).at(-1) as Extract<LoggedEvent, { type: 'turn/end' }>;
    expect(end).toMatchObject({ reason: 'completed', outcome: 'success' });
  });

  it('marks the reason a turn ended: stopped, error, step limit', async () => {
    h = makeHarness([new Error('接口挂了')]);
    await h.run('a');
    h.settings.maxSteps = 1;
    h.llm.push(call('get_known_folders', {}), say('只能到这了'));
    await h.run('b');
    const ends = sessionEvents(h.baseDir).filter((e) => e.type === 'turn/end') as Extract<LoggedEvent, { type: 'turn/end' }>[];
    expect(ends.map((e) => e.reason)).toEqual(['error', 'max-steps']);
  });

  it('repairs a turn cut off by a crash and offers it to /resume', () => {
    const platform = new FakePlatform();
    try {
      const dir = path.join(platform.root, 'sessions');
      const a = new SessionStore(dir);
      a.append({ type: 'turn/start', turnId: 't1', userText: '把下载里的图片整理一下' });
      a.append({ type: 'tool/result', turnId: 't1', callId: 'c1', name: 'move_files', result: { title: '移动 3 个文件', status: 'ok', summary: '移动了 3 个', external: false } });
      // …the app dies here. Next start:
      const b = new SessionStore(dir);
      expect(b.id).toBe(a.id);
      const last = b.lastUnfinished();
      expect(last).toMatchObject({ turnId: 't1', reason: 'interrupted', userText: '把下载里的图片整理一下' });
      expect(last?.steps).toHaveLength(1);
      // Repair happens once.
      const c = new SessionStore(dir);
      const ends = fs.readFileSync(path.join(dir, `${c.id}.jsonl`), 'utf8').split('\n').filter((l) => l.includes('turn/end'));
      expect(ends).toHaveLength(1);
    } finally { platform.cleanup(); }
  });

  it('survives a torn last line', () => {
    const platform = new FakePlatform();
    try {
      const dir = path.join(platform.root, 'sessions');
      const a = new SessionStore(dir);
      a.append({ type: 'turn/start', turnId: 't1', userText: 'x' });
      fs.appendFileSync(path.join(dir, `${a.id}.jsonl`), '{"type":"tool/res');
      expect(() => new SessionStore(dir)).not.toThrow();
    } finally { platform.cleanup(); }
  });

  it('keeps cross-turn context across a restart (recaps rebuilt from the log)', async () => {
    h = makeHarness();
    const dir = path.join(h.platform.folders.desktop, '重启后还记得');
    h.llm.push(call('create_directory', { path: dir }), say('建好啦'));
    await h.run('建个重启后还记得的文件夹');
    // "Restart": a new runtime on the same data folder.
    h2 = makeHarness([say('好')], { baseDir: h.baseDir, platform: h.platform });
    await h2.run('打开它', { history: [{ role: 'user', content: '建个重启后还记得的文件夹' }, { role: 'assistant', content: '建好啦' }] });
    expect(systemText(h2.llm.requests[0]?.messages)).toContain(dir);
  });
});

describe('/resume', () => {
  it('picks up an unfinished task with what was already done', async () => {
    h = makeHarness([call('create_directory', { path: '~/Desktop/第一步' }), new Error('网络断了')]);
    await h.run('分三步建文件夹');
    const r = cmd(h, '/resume');
    expect(r).toMatchObject({ action: 'send' });
    expect(r?.prompt).toContain('分三步建文件夹');
    h.llm.push(say('接着做完了'));
    await h.run(r?.prompt as string);
    const sys = systemText(h.llm.requests.at(-1)?.messages);
    expect(sys).toContain('要继续的上一个任务');
    expect(sys).toContain('第一步');
    // Only once.
    h.llm.push(say('嗯'));
    await h.run('再说一句');
    expect(systemText(h.llm.requests.at(-1)?.messages)).not.toContain('要继续的上一个任务');
    expect(cmd(h, '/resume')?.action).toBeUndefined();          // nothing unfinished now
  });
});

describe('turn hooks', () => {
  it('a tool/pre guard blocks a call; the first denial wins', async () => {
    h = makeHarness([call('create_directory', { path: '~/Desktop/不许建' }), (m) => { expect(String(lastToolResult(m).error)).toContain('规则不允许'); return say('没建'); }]);
    h.rt.hooks.on('tool/pre', 'rule', (_ctx, c) => (c.name === 'create_directory' ? { deny: '规则不允许新建文件夹' } : undefined));
    h.rt.hooks.on('tool/pre', 'late', () => undefined);
    const r = await h.run('建一个');
    expect(fs.existsSync(path.join(h.platform.folders.desktop, '不许建'))).toBe(false);
    expect(r.confirms).toHaveLength(0);
    expect(finalSteps(r)[0]?.status).toBe('denied');
  });

  it('a guard that throws blocks the call (fail closed); other listeners failing do not break the turn', async () => {
    h = makeHarness([call('create_directory', { path: '~/Desktop/x' }), say('好')]);
    h.rt.hooks.on('tool/pre', 'buggy-guard', () => { throw new Error('boom'); });
    h.rt.hooks.on('step/pre', 'buggy', () => { throw new Error('boom'); });
    const r = await h.run('建');
    expect(r.done?.reply).toBe('好');
    expect(fs.existsSync(path.join(h.platform.folders.desktop, 'x'))).toBe(false);
  });

  it('emits the lifecycle in order', async () => {
    h = makeHarness([call('get_known_folders', {}), say('好')]);
    const seen: string[] = [];
    for (const ev of ['turn/start', 'step/pre', 'assistant/message', 'tool/post', 'turn/end'] as const) {
      h.rt.hooks.on(ev, 'probe', () => { seen.push(ev); });
    }
    h.rt.hooks.on('tool/pre', 'probe', () => { seen.push('tool/pre'); });
    await h.run('桌面在哪');
    expect(seen).toEqual(['turn/start', 'step/pre', 'assistant/message', 'tool/pre', 'tool/post', 'step/pre', 'turn/end']);
  });
});

describe('parallel read-only tools', () => {
  const probe = () => {
    const live = { now: 0, max: 0, order: [] as string[] };
    const mk = (name: string, safe: boolean) => defineTool<{ tag: string }>({
      name, group: 'files', description: name, riskLevel: 'low', requiresConfirmation: false, concurrencySafe: safe,
      inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
      title: (a) => `${name} ${a.tag}`,
      execute: async (a) => {
        live.now++; live.max = Math.max(live.max, live.now); live.order.push(`start ${a.tag}`);
        await new Promise((r) => setTimeout(r, 60));
        live.now--; live.order.push(`end ${a.tag}`);
        return { ok: true, summary: a.tag };
      },
    });
    return { live, safe: mk('probe_read', true), unsafe: mk('probe_write', false) };
  };

  it('runs neighbouring safe calls together, others alone, and returns results in order', async () => {
    h = makeHarness();
    const { live, safe, unsafe } = probe();
    h.rt.registry.register(safe); h.rt.registry.register(unsafe);
    h.llm.push(
      calls(['probe_read', { tag: 'a' }], ['probe_read', { tag: 'b' }], ['probe_write', { tag: 'w' }], ['probe_read', { tag: 'c' }]),
      (m) => {
        const results = m.filter((x) => x.role === 'tool').map((x) => JSON.parse(String(x.content)).summary);
        expect(results).toEqual(['a', 'b', 'w', 'c']);
        return say('好');
      },
    );
    await h.run('看看');
    expect(live.max).toBe(2);                                // a and b overlapped
    const w = live.order.indexOf('start w');
    expect(live.order.slice(0, w)).toEqual(expect.arrayContaining(['end a', 'end b']));   // w waited for them
    expect(live.order.indexOf('start c')).toBeGreaterThan(live.order.indexOf('end w'));   // c waited for w
  });

  it('never runs a tool that asks the user in parallel', async () => {
    h = makeHarness();
    const { live, safe } = probe();
    h.rt.registry.register({ ...safe, requiresConfirmation: true });
    h.llm.push(calls(['probe_read', { tag: 'a' }], ['probe_read', { tag: 'b' }]), say('好'));
    await h.run('看看');
    expect(live.max).toBe(1);
  });

  it('built-in read-only tools are marked safe, writes are not', () => {
    h = makeHarness();
    expect(h.rt.registry.get('list_directory')?.concurrencySafe).toBe(true);
    expect(h.rt.registry.get('read_file')?.concurrencySafe).toBeFalsy();
    expect(h.rt.registry.get('create_directory')?.concurrencySafe).toBeFalsy();
  });
});

describe('slash commands', () => {
  it('help, status, tools, unknown, and text that only looks like a command', async () => {
    h = makeHarness();
    expect(cmd(h, '/help')?.reply).toContain('/resume');
    expect(cmd(h, '/status')?.reply).toContain('会话');
    expect(cmd(h, '/tools')?.reply).toContain('list_directory');
    expect(cmd(h, '/nope')?.reply).toContain('/help');
    expect(cmd(h, '/r/programming 是什么')).toBeNull();
    expect(cmd(h, '你好')).toBeNull();
  });

  it('/new starts a fresh session and forgets carried context', async () => {
    h = makeHarness([call('create_directory', { path: '~/Desktop/旧会话' }), say('好')]);
    await h.run('建旧会话文件夹');
    const before = h.rt.sessions.id;
    await new Promise((r) => setTimeout(r, 5));
    expect(cmd(h, '/new')).toMatchObject({ action: 'clear' });
    expect(h.rt.sessions.id).not.toBe(before);
    h.llm.push(say('嗯'));
    await h.run('刚才那个', { history: [{ role: 'user', content: '建旧会话文件夹' }, { role: 'assistant', content: '好' }] });
    expect(systemText(h.llm.requests.at(-1)?.messages)).not.toContain('旧会话');
  });
});

describe('foldTurns', () => {
  it('rebuilds turns from events', () => {
    const ev = (e: object, seq: number) => ({ ...e, seq, t: '' }) as LoggedEvent;
    const turns = foldTurns([
      ev({ type: 'turn/start', turnId: 'a', userText: 'x' }, 1),
      ev({ type: 'tool/result', turnId: 'a', callId: '1', name: 'n', result: { title: 't', status: 'ok', summary: 's', external: false } }, 2),
      ev({ type: 'turn/end', turnId: 'a', reason: 'completed', outcome: 'success' }, 3),
    ]);
    expect(turns).toEqual([{ turnId: 'a', userText: 'x', steps: [{ title: 't', status: 'ok', summary: 's', external: false }], reason: 'completed', outcome: 'success' }]);
  });
});

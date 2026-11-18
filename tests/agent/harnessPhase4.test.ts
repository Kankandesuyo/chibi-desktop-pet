/**
 * Harness phase 4: scheduled / proactive tasks (unattended, read-only runs) and helpers (subagents).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../../electron/agent/Scheduler';
import type { LlmMessage, LlmTurn } from '../../electron/agent/llm';
import { call, calls, FakePlatform, finalSteps, lastToolResult, makeHarness, say, type Harness } from './helpers';

let h: Harness | undefined;
let platform: FakePlatform | undefined;
afterEach(() => { h?.cleanup(); h = undefined; platform?.cleanup(); platform = undefined; });
const at = (s: string): Date => new Date(s);

describe('Scheduler', () => {
  const make = (count: () => number | null = () => 0): Scheduler => { platform = new FakePlatform(); return new Scheduler(path.join(platform.root, 'schedules.json'), count); };

  it('validates triggers', () => {
    const s = make();
    const now = at('2026-11-18T08:00:00');
    expect(() => s.add({ name: 'x', prompt: 'y', trigger: { kind: 'daily', time: '25:00' } }, now)).toThrow('09:00');
    expect(() => s.add({ name: 'x', prompt: 'y', trigger: { kind: 'interval', minutes: 5 } }, now)).toThrow('15');
    expect(() => s.add({ name: 'x', prompt: 'y', trigger: { kind: 'once', at: '2026-11-17T08:00:00' } }, now)).toThrow('过去');
    expect(() => s.add({ name: 'x', prompt: 'y', trigger: { kind: 'folder', path: 'relative', minFiles: 3 } }, now)).toThrow('完整路径');
    expect(() => s.add({ name: '', prompt: 'y', trigger: { kind: 'daily', time: '9:00' } }, now)).toThrow('名字');
    expect(s.add({ name: '早报', prompt: '看看下载', trigger: { kind: 'daily', time: '9:00' } }, now).trigger).toEqual({ kind: 'daily', time: '09:00' });
  });

  it('daily: runs once a day, catches up a missed run within 6 hours, and survives a restart', () => {
    const s = make();
    const t = s.add({ name: '早报', prompt: 'p', trigger: { kind: 'daily', time: '09:00' } }, at('2026-11-18T07:00:00'));
    expect(s.due(at('2026-11-18T08:59:00'))).toHaveLength(0);
    expect(s.due(at('2026-11-18T09:00:30')).map((x) => x.id)).toEqual([t.id]);
    s.markRun(t.id, at('2026-11-18T09:00:30'));
    expect(s.due(at('2026-11-18T12:00:00'))).toHaveLength(0);
    expect(s.nextRun(s.get(t.id)!, at('2026-11-18T12:00:00'))?.toISOString()).toBe(at('2026-11-19T09:00:00').toISOString());
    // App closed through the morning: started at 11:00 the next day → runs; started at 16:00 → skipped until tomorrow.
    const again = new Scheduler(s.file);
    expect(again.due(at('2026-11-19T11:00:00'))).toHaveLength(1);
    expect(again.due(at('2026-11-19T16:00:00'))).toHaveLength(0);
  });

  it('interval, once and folder triggers', () => {
    let files = 3;
    const s = make(() => files);
    const now = at('2026-11-18T10:00:00');
    const iv = s.add({ name: 'i', prompt: 'p', trigger: { kind: 'interval', minutes: 30 } }, now);
    const once = s.add({ name: 'o', prompt: 'p', trigger: { kind: 'once', at: '2026-11-18T12:00:00' } }, now);
    const folder = s.add({ name: 'f', prompt: 'p', trigger: { kind: 'folder', path: platform!.folders.downloads, minFiles: 5 } }, now);
    expect(s.due(at('2026-11-18T10:20:00'))).toHaveLength(0);
    expect(s.due(at('2026-11-18T10:31:00')).map((x) => x.id)).toEqual([iv.id]);
    s.markRun(iv.id, at('2026-11-18T10:31:00'));
    expect(s.due(at('2026-11-18T12:00:00')).map((x) => x.id)).toEqual([iv.id, once.id]);   // the 30-minute one is due again too
    s.markRun(once.id, at('2026-11-18T12:00:00'));
    s.markRun(iv.id, at('2026-11-18T12:00:00'));
    expect(s.get(once.id)?.enabled).toBe(false);                 // one-off switches itself off
    files = 6;
    expect(s.due(at('2026-11-18T12:01:00')).map((x) => x.id)).toEqual([folder.id]);
    s.markRun(folder.id);
    expect(s.due(at('2026-11-18T12:02:00')).map((x) => x.id)).not.toContain(folder.id);   // not again while still full
    files = 2; s.due(at('2026-11-18T12:03:00'));                 // emptied → re-armed
    files = 9;
    expect(s.due(at('2026-11-18T12:04:00')).map((x) => x.id)).toContain(folder.id);
  });
});

describe('scheduled runs (unattended, read-only)', () => {
  it('never asks and never changes anything; the result is kept on the task', async () => {
    h = makeHarness();
    const task = h.rt.scheduler.add({ name: '看看桌面', prompt: '看看桌面有什么', trigger: { kind: 'daily', time: '09:00' } });
    const done: string[] = [];
    h.rt.onScheduledDone((t, text) => done.push(`${t.name}:${text}`));
    h.llm.push(
      call('list_directory', { path: h.platform.folders.desktop }),
      call('create_directory', { path: '~/Desktop/定时任务不能建' }),
      (m) => { expect(String(lastToolResult(m).error)).toContain('只读'); return say('桌面是空的；想新建的文件夹我没有建，等你回来决定。'); },
    );
    const r = await h.run(`⏰ 定时任务「看看桌面」：看看桌面有什么`, { runOptions: { readOnly: true, unattended: true, scheduleId: task.id } });
    expect(r.confirms).toHaveLength(0);
    expect(fs.existsSync(path.join(h.platform.folders.desktop, '定时任务不能建'))).toBe(false);
    expect(String(h.llm.requests[0]?.messages[0]?.content)).toContain('无人值守的定时任务');
    expect(h.rt.scheduler.get(task.id)?.lastResult).toContain('桌面是空的');
    expect(done).toEqual([expect.stringContaining('看看桌面:桌面是空的')]);
  });

  it('a step that would need a confirmation is skipped, not asked, when nobody is there', async () => {
    h = makeHarness();
    const f = path.join(h.platform.folders.documents, '.env'); fs.writeFileSync(f, 'SECRET=1');
    h.llm.push(call('read_file', { path: f }), (m) => { expect(String(lastToolResult(m).error)).toContain('无人值守'); return say('没读'); });
    const r = await h.run('读一下', { runOptions: { readOnly: true, unattended: true } });
    expect(r.confirms).toHaveLength(0);
  });

  it('schedule_task always asks, checks the folder, and the task can be listed and cancelled', async () => {
    h = makeHarness([call('schedule_task', { name: '下载提醒', prompt: '看看下载文件夹，提醒我整理', trigger: { kind: 'folder', path: '~/Downloads', minFiles: 50 } }), say('安排好了')]);
    const r = await h.run('下载文件夹超过 50 个文件时提醒我');
    expect(r.confirms[0]).toMatchObject({ tool: 'schedule_task', risk: 'medium' });
    expect(r.confirms[0]?.preview.join('\n')).toContain('超过 50 个文件时');
    const [t] = h.rt.scheduler.list();
    expect(t?.trigger).toEqual({ kind: 'folder', path: h.platform.folders.downloads, minFiles: 50 });
    expect(h.rt.command('/schedule')?.reply).toContain('下载提醒');
    h.llm.push(call('schedule_task', { name: '偷看', prompt: 'x', trigger: { kind: 'folder', path: path.join(h.platform.root, 'outside'), minFiles: 1 } }), say('不行'));
    const r2 = await h.run('盯着那个文件夹');
    expect(finalSteps(r2)[0]?.status).toBe('denied');                // not an allowed folder
    h.llm.push(call('cancel_schedule', { id: t!.id }), say('删了'));
    await h.run('不用提醒了');
    expect(h.rt.scheduler.list()).toHaveLength(0);
  });
});

describe('helpers (subagents)', () => {
  /** A scripted "model" that plays every helper: look once, then report on its own task. */
  const helperStep = (m: LlmMessage[]): LlmTurn => {
    const task = String(m[1]?.content ?? '');
    return m[m.length - 1]?.role === 'tool' ? say(`结论：${task} 有 0 个文件`) : call('list_directory', { path: '~/Desktop' });
  };

  it('runs helpers side by side, each with its own context and only looking tools', async () => {
    h = makeHarness();
    let parentSaw = '';
    h.llm.push(
      calls(['delegate_task', { task: '查桌面' }], ['delegate_task', { task: '查下载' }]),
      helperStep, helperStep, helperStep, helperStep,
      (m) => { parentSaw = m.filter((x) => x.role === 'tool').map((x) => String(x.content)).join('\n'); return say('两边都查完了'); },
    );
    const r = await h.run('同时看看桌面和下载');
    expect(parentSaw).toContain('结论：查桌面');
    expect(parentSaw).toContain('结论：查下载');
    const helperRequests = h.llm.requests.filter((q) => String(q.messages[0]?.content).startsWith('你是桌宠派出去的一个小帮手'));
    expect(helperRequests).toHaveLength(4);
    for (const q of helperRequests) {
      const tools = q.tools?.map((t) => t.function.name) ?? [];
      expect(tools).toContain('list_directory');
      expect(tools).not.toContain('create_directory');
      expect(tools).not.toContain('delegate_task');                 // no helpers of their own
      expect(q.messages.some((x) => String(x.content).includes('同时看看桌面和下载'))).toBe(false);   // fresh context
    }
    const titles = r.events.filter((e) => e.type === 'step').map((e) => (e as { step: { title: string } }).step.title);
    expect(titles.some((t) => t.startsWith('【小帮手1】'))).toBe(true);
    expect(titles.some((t) => t.startsWith('【小帮手2】'))).toBe(true);
    expect(r.done?.outcome).toBe('success');
  });

  it('a helper cannot change anything even if it tries', async () => {
    h = makeHarness();
    h.llm.push(
      call('delegate_task', { task: '建个文件夹' }),
      call('create_directory', { path: '~/Desktop/小帮手不能建' }),
      (m) => say(String(lastToolResult(m).error)),
      (m) => { expect(String(lastToolResult(m).data)).toContain('只读'); return say('好'); },
    );
    const r = await h.run('派个帮手');
    expect(fs.existsSync(path.join(h.platform.folders.desktop, '小帮手不能建'))).toBe(false);
    expect(r.confirms).toHaveLength(0);
  });

  it('limits how many helpers one task may start', async () => {
    h = makeHarness();
    const many = Array.from({ length: 7 }, (_, i) => ['delegate_task', { task: `任务${i}` }] as [string, Record<string, unknown>]);
    h.llm.push(calls(...many), ...Array.from({ length: 12 }, () => helperStep), (m) => {
      const results = m.filter((x) => x.role === 'tool').map((x) => String(x.content));
      expect(results.filter((x) => x.includes('最多派')).length).toBe(1);
      return say('好');
    });
    await h.run('派很多帮手');
  });
});

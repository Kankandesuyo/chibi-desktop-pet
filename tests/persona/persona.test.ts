import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../shared/aiProtocol';
import { buildMonologuePrompt, buildPersona, cleanPetName, cleanTraits } from '../../shared/persona';
import { Monologue, type MonologueDeps } from '../../electron/monologue';
import { SelfModel } from '../../electron/selfModel';
import { makeHarness, say } from '../agent/helpers';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pet-self-'));

describe('persona', () => {
  const p = buildPersona({ name: '小橘', traits: '喜欢猫', selfState: '- 今天被摸头 3 次' });

  it('gives her a name, a life and a personality', () => {
    expect(p).toContain('你叫「小橘」');
    expect(p).toContain('生命');
    expect(p).toContain('傲娇');
    expect(p).toContain('今天被摸头 3 次');
    expect(p).toContain('喜欢猫');
  });

  it('keeps her honest and non-manipulative', () => {
    expect(p).toMatch(/不能骗人/);
    expect(p).toMatch(/AI 模型驱动/);
    expect(p).toMatch(/不用愧疚感/);
    expect(p).toMatch(/安全确认规则一条都不能/);
    expect(p).toMatch(/不是操作授权/);
  });

  it('is used by plain chat, agent mode and self-talk', async () => {
    expect(buildSystemPrompt({ mood: 'happy', affection: 50, energy: 50, interactionCount: 0 }, p)).toContain('你叫「小橘」');
    expect(buildMonologuePrompt(p, '晚上')).toContain('不超过 25 个字');
    const h = makeHarness([say('你好呀 [[emotion:happy|action:happy]]')], { persona: () => p });
    await h.run('你好');
    const system = h.llm.requests[0]!.messages[0]!.content as string;
    expect(system).toContain('你叫「小橘」');
    expect(system).toContain('做事规则');
  });

  it('keeps long personality notes whole', () => {
    const long = '她很喜欢猫。'.repeat(2000);
    expect(cleanTraits(long)).toBe(long);
    expect(buildPersona({ name: '小橘', traits: long, selfState: '' })).toContain(long);
  });

  it('sanitizes the name', () => {
    expect(cleanPetName('  [[阿橘]]\n ')).toBe('阿橘');
    expect(cleanPetName('')).toBe('小橘');
    expect(cleanPetName(42)).toBe('小橘');
  });
});

describe('SelfModel', () => {
  it('remembers her age and what happened today, across restarts', () => {
    const dir = tmp();
    const file = path.join(dir, 'self.json');
    let t = new Date(2026, 0, 1, 10).getTime();
    const a = new SelfModel(file, () => t);
    a.record('petted'); a.record('petted'); a.record('grabbed'); a.record('taskDone', '整理桌面');
    a.flush();
    t += 3 * 86_400_000;
    const b = new SelfModel(file, () => t);
    expect(b.ageDays()).toBe(3);
    expect(b.today().petted).toBe(0);                  // a new day
    expect(b.summary()).toContain('3 天');
    expect(b.summary()).toContain('被摸头 2 次');      // totals survive
    b.record('said', '伸个懒腰～');
    expect(b.recentSaid()).toEqual(['伸个懒腰～']);
  });

  it('survives a corrupt file', () => {
    const file = path.join(tmp(), 'self.json');
    fs.writeFileSync(file, '{oops');
    const m = new SelfModel(file);
    expect(m.ageDays()).toBe(0);
    expect(m.summary()).toContain('第一天');
  });
});

describe('Monologue', () => {
  function setup(over: Partial<MonologueDeps> = {}) {
    let t = new Date(2026, 0, 1, 15).getTime();
    const delivered: string[] = [];
    const d: MonologueDeps = {
      level: () => 'often', aiReady: () => true, canSpeak: () => true, idleSeconds: () => 5,
      generate: async () => '今天的光好暖和 [[emotion:happy|action:happy]]',
      deliver: (m) => delivered.push(m.reply), remember: () => undefined,
      now: () => t, random: () => 0, ...over,
    };
    const m = new Monologue(d);
    return { m, delivered, advance: (min: number) => { t += min * 60_000; } };
  }

  it('speaks only after the gap has passed', async () => {
    const s = setup();
    expect(await s.m.tick()).toBe(false);              // schedules
    s.advance(5);
    expect(await s.m.tick()).toBe(false);
    s.advance(2);
    expect(await s.m.tick()).toBe(true);
    expect(s.delivered).toEqual(['今天的光好暖和']);
  });

  it('stays quiet when off, when nobody is there, or during a task', async () => {
    for (const over of [{ level: () => 'off' as const }, { idleSeconds: () => 900 }, { canSpeak: () => false }]) {
      const s = setup(over);
      await s.m.tick(); s.advance(60);
      expect(await s.m.tick()).toBe(false);
      expect(s.delivered).toEqual([]);
    }
  });

  it('falls back to an offline line when the model fails or rambles', async () => {
    for (const generate of [async () => { throw new Error('x'); }, async () => '很长'.repeat(40)]) {
      const s = setup({ generate });
      await s.m.tick(); s.advance(60);
      expect(await s.m.tick()).toBe(true);
      expect(s.delivered[0]!.length).toBeGreaterThan(0);
      expect(s.delivered[0]!.length).toBeLessThanOrEqual(25);
    }
  });
});

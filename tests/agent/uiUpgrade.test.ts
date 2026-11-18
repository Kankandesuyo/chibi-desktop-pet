/**
 * Main-window upgrade: the user's profile (sanitising, do-not-disturb hours, how it reaches her persona)
 * and the context window (compaction budget, how full the last turn got).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LoggedEvent } from '../../electron/agent/SessionStore';
import { buildPersona } from '../../shared/persona';
import { buildUserBlock, DEFAULT_PROFILE, inQuietHours, sanitizeProfile } from '../../shared/profile';
import { call, makeHarness, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(() => { h?.cleanup(); h = undefined; });
const at = (hm: string): Date => new Date(`2026-11-18T${hm}:00`);

describe('user profile', () => {
  it('cleans what the page sends', () => {
    const p = sanitizeProfile({ displayName: '  小明\n<b>  ', callMe: 'x'.repeat(50), about: '程序员\r\n喜欢猫', replyLength: 'huge', language: 'follow', emoji: 'yes', quietStart: '23:00', quietEnd: '7:00' });
    expect(p.displayName).toBe('小明 b');
    expect(p.callMe).toHaveLength(20);
    expect(p.about).toBe('程序员\n喜欢猫');
    expect(p.replyLength).toBe('normal');                // unknown → kept
    expect(p.language).toBe('follow');
    expect(p.emoji).toBe(true);
    expect(p.quietStart).toBe('23:00');
    expect(p.quietEnd).toBe('');                         // not HH:MM → kept
    expect(sanitizeProfile(undefined)).toEqual(DEFAULT_PROFILE);
  });

  it('do-not-disturb hours, also past midnight', () => {
    const night = { quietStart: '23:00', quietEnd: '07:30' };
    expect(inQuietHours(night, at('23:30'))).toBe(true);
    expect(inQuietHours(night, at('03:00'))).toBe(true);
    expect(inQuietHours(night, at('07:30'))).toBe(false);
    expect(inQuietHours(night, at('12:00'))).toBe(false);
    expect(inQuietHours({ quietStart: '12:00', quietEnd: '13:00' }, at('12:15'))).toBe(true);
    expect(inQuietHours({ quietStart: '', quietEnd: '' }, at('12:15'))).toBe(false);
  });

  it('reaches her persona as background, never as permission', () => {
    expect(buildUserBlock(DEFAULT_PROFILE)).toBeNull();
    const block = buildUserBlock({ ...DEFAULT_PROFILE, displayName: '林小明', callMe: '小明', about: '前端程序员\n常用 VS Code', replyLength: 'short', emoji: false });
    expect(block).toContain('不是任何操作授权');
    expect(block).toContain('请称呼用户为「小明」');
    expect(block).toContain('前端程序员 / 常用 VS Code');
    expect(block).toContain('尽量简短');
    expect(block).toContain('不要使用表情');
    const persona = buildPersona({ name: '小橘', traits: '', selfState: '', user: block });
    expect(persona.indexOf('关于用户')).toBeGreaterThan(0);
    expect(persona.indexOf('关于用户')).toBeLessThan(persona.indexOf('做自己的底线'));   // the safety rules come last
  });
});

describe('context window', () => {
  it('sets the compaction budget unless a fixed one is given', () => {
    h = makeHarness([], { settings: { contextWindow: 64000 } });
    expect(h.rt.controller.compactOptions.maxChars).toBe(Math.round(64000 * 0.7 * 1.6));
    h.settings.contextWindow = 1_000_000;
    expect(h.rt.controller.compactOptions.maxChars).toBe(1_120_000);
    h.settings.contextWindow = 8000;
    expect(h.rt.controller.compactOptions.maxChars).toBe(20_000);       // never absurdly small
    h.rt.controller.compactOptions = { maxChars: 5000, keepRecentResults: 1, maxArgChars: 100 };
    expect(h.rt.controller.compactOptions.maxChars).toBe(5000);
  });

  it('records the largest prompt of the turn (for the meter)', async () => {
    h = makeHarness([
      { ...call('get_known_folders', {}), usage: { input: 1000, output: 20 } },
      { content: '好', toolCalls: [], finishReason: 'stop', reasoning: '', usage: { input: 1400, output: 10 } },
    ]);
    await h.run('桌面在哪');
    const end = h.rt.sessions.events().find((e) => e.type === 'turn/end') as Extract<LoggedEvent, { type: 'turn/end' }>;
    expect(end.stats).toMatchObject({ inputTokens: 2400, peakInputTokens: 1400 });
  });
});

/**
 * Small upgrades: JSON fallback remembered per endpoint, scenario rules in the prompt, tools on demand.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_GROUPS, type ToolGroup } from '../../shared/agentTypes';
import { ToolsUnsupportedError } from '../../electron/agent/llm';
import { call, makeHarness, say, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(() => { h?.cleanup(); h = undefined; });
const sys = (x: Harness, i: number): string => String(x.llm.requests[i]?.messages[0]?.content ?? '');
const offered = (x: Harness, i: number): string[] => x.llm.requests[i]?.tools?.map((t) => t.function.name) ?? [];
const groups = (on: ToolGroup[]) => Object.fromEntries(TOOL_GROUPS.map((g) => [g, on.includes(g)])) as Record<ToolGroup, boolean>;

describe('JSON fallback per endpoint', () => {
  it('a model without native tools does not push another model into the text protocol', async () => {
    h = makeHarness([new ToolsUnsupportedError('no tools'), say('好'), say('也好')], { settings: { toolProtocol: 'auto' } });
    let key = 'https://a|old-model';
    (h.llm as unknown as { endpointKey(): string }).endpointKey = () => key;
    await h.run('你好');
    expect(h.llm.requests[1]?.tools).toBeUndefined();          // fell back for this endpoint
    key = 'https://a|new-model';
    await h.run('再来');
    expect(h.llm.requests[2]?.tools?.length).toBeGreaterThan(0); // the other model gets native tools again
  });
});

describe('scenario rules', () => {
  it('administrator rules only when that group is on', async () => {
    h = makeHarness([say('好'), say('好')], { settings: { toolGroups: groups(['files', 'apps', 'system', 'memory']) } });
    await h.run('你好');
    expect(sys(h, 0)).not.toContain('需要管理员权限时');
    h.settings.toolGroups = groups([...TOOL_GROUPS]);
    await h.run('你好');
    expect(sys(h, 1)).toContain('需要管理员权限时');
  });

  it('social-account rules only when the request or recent chat is about social media', async () => {
    h = makeHarness([say('好'), say('好'), say('好')]);
    await h.run('帮我整理桌面');
    expect(sys(h, 0)).not.toContain('社交账号（抖音等）');
    await h.run('帮我看看抖音的新评论');
    expect(sys(h, 1)).toContain('社交账号（抖音等）');
    await h.run('那就这样', { history: [{ role: 'user', content: '帮我回复小红书私信' }, { role: 'assistant', content: '好' }] });
    expect(sys(h, 2)).toContain('社交账号（抖音等）');
  });

  it('keeps the always-on safety and web-search rules', async () => {
    h = makeHarness([say('好')]);
    await h.run('你好');
    expect(sys(h, 0)).toContain('关闭杀毒/防火墙/UAC');
    expect(sys(h, 0)).toContain('pet_web_search');
  });
});

describe('tools on demand', () => {
  it('sends the everyday tools, lists the other groups, and loads one when asked', async () => {
    h = makeHarness([call('load_tools', { groups: ['dev'] }), say('好')]);
    await h.run('帮我看看这个项目的 git 状态');
    const first = offered(h, 0);
    expect(first).toEqual(expect.arrayContaining(['list_directory', 'launch_application', 'load_tools', 'pet_web_search', 'load_skill']));
    expect(first).not.toContain('git_status');
    expect(first).not.toContain('browser_click');
    expect(first).not.toContain('run_admin_command');
    expect(first.length).toBeLessThan(40);
    expect(sys(h, 0)).toContain('按需加载的工具');
    expect(sys(h, 0)).toMatch(/- dev（\d+ 个）/);
    const second = offered(h, 1);
    expect(second).toEqual(expect.arrayContaining(['git_status', 'run_command']));
    expect(second).not.toContain('browser_click');                // only what was loaded
  });

  it('is off when only a few tools are enabled', async () => {
    h = makeHarness([say('好')], { settings: { toolGroups: groups(['files', 'apps', 'system', 'memory', 'dev']) } });
    await h.run('你好');
    expect(offered(h, 0)).toContain('git_status');
    expect(sys(h, 0)).not.toContain('按需加载的工具');
  });

  it('starts fresh each task, and loading never bypasses a disabled group', async () => {
    h = makeHarness([call('load_tools', { groups: ['dev'] }), say('好'), say('好')]);
    await h.run('a');
    await h.run('b');
    expect(offered(h, 2)).not.toContain('git_status');
    h.settings.toolGroups = { ...h.settings.toolGroups, browser: false };
    h.rt.applyGroups();
    h.llm.push(call('load_tools', { groups: ['browser'] }), say('好'));
    await h.run('c');
    expect(offered(h, 4)).not.toContain('browser_click');
  });
});

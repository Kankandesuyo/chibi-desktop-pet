/** Ported from remote-chat/app-reuse.test.cjs: an existing WeChat is reused, never launched twice. */
import { describe, expect, it } from 'vitest';
import { guardWeChatLaunch } from '../../electron/agent/tools/appReuse';
import type { DesktopPlatform, UiWindowInfo } from '../../electron/agent/types';

type P = Pick<DesktopPlatform, 'ui' | 'listRunningApps'>;
const platform = (rows: Partial<UiWindowInfo>[]): P => ({
  ui: { listWindows: async () => rows as UiWindowInfo[] } as unknown as DesktopPlatform['ui'],
  listRunningApps: async () => [],
});

describe('WeChat launch guard', () => {
  it('returns existing main and login windows without claiming login state', async () => {
    const r = await guardWeChatLaunch('C:\\Program Files\\Tencent\\Weixin\\Weixin.exe', platform([
      { pid: 11, handle: 21, title: '微信', processName: 'WeChat' },
      { pid: 12, handle: 22, title: '微信', processName: 'Weixin' },
      { pid: 13, handle: 23, title: '微信开发文档 - Chrome', processName: 'chrome' },
    ]));
    const data = r?.data as { reusedExisting: boolean; windows: { loginState: string }[] };
    expect(data.reusedExisting).toBe(true);
    expect(data.windows).toHaveLength(2);
    expect(data.windows.every((w) => w.loginState === 'unknown')).toBe(true);
  });

  it('a shortcut alias plus a running process prevents a duplicate launch even without a window', async () => {
    const p = platform([]);
    p.listRunningApps = async () => [{ pid: 10, name: 'Weixin', title: '' }];
    expect((await guardWeChatLaunch('C:\\开始菜单\\微信.lnk', p))?.data).toMatchObject({ reusedExisting: true });
  });

  it('no WeChat running allows a normal launch; other apps are unaffected', async () => {
    expect(await guardWeChatLaunch('WeChat.exe', platform([]))).toBeNull();
    expect(await guardWeChatLaunch('notepad.exe', {} as P)).toBeNull();
  });

  it('an enumeration failure blocks the relaunch instead of assuming no session', async () => {
    const p = platform([]);
    p.ui.listWindows = async () => { throw new Error('denied'); };
    expect((await guardWeChatLaunch('Weixin.exe', p))?.ok).toBe(false);
  });
});

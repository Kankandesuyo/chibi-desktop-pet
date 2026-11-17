'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { guardWeChatLaunch } = require('./app-reuse.cjs');
const platform = rows => ({ ui: { listWindows: async () => rows }, listRunningApps: async () => [] });
test('existing main and login windows are both returned without claiming login state', async () => {
  const r = await guardWeChatLaunch('C:\\Program Files\\Tencent\\Weixin\\Weixin.exe', platform([
    { pid: 11, handle: '21', title: '微信', processName: 'WeChat' },
    { pid: 12, handle: '22', title: '微信', processName: 'Weixin' },
    { pid: 13, handle: '23', title: '微信开发文档 - Chrome', processName: 'chrome' }
  ]));
  assert.equal(r.data.reusedExisting, true); assert.equal(r.data.windows.length, 2);
  assert.ok(r.data.windows.every(w => w.loginState === 'unknown'));
});
test('shortcut alias and existing process prevent duplicate launch even without a listed window', async () => {
  const p = platform([]); p.listRunningApps = async () => [{ pid: 10, name: 'Weixin', title: '' }];
  assert.equal((await guardWeChatLaunch('C:\\开始菜单\\微信.lnk', p)).data.reusedExisting, true);
});
test('no existing WeChat allows normal launch; other applications are unaffected', async () => {
  assert.equal(await guardWeChatLaunch('WeChat.exe', platform([])), null);
  assert.equal(await guardWeChatLaunch('notepad.exe', { }), null);
});
test('enumeration failure blocks relaunch instead of assuming no session', async () => {
  const p = platform([]); p.ui.listWindows = async () => { throw new Error('denied'); };
  assert.equal((await guardWeChatLaunch('Weixin.exe', p)).ok, false);
});

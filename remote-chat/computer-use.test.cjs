const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createComputerTools, keyCodes, physicalPoint } = require('./computer-use/tools.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-computer-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 0, calls = 0, reads = 0, changed = false, moved = false, verified = true, lastNative;
  const abort = new AbortController();
  const frame = () => ({ meta: { handle: 10, pid: 20, born: '123', title: '独立测试窗口', left: moved ? 1 : 0, top: 0, right: 100, bottom: 100 }, rect: { left: 0, top: 0, right: 100, bottom: 100 }, size: { width: 100, height: 100 }, patch: changed ? 'new' : 'old', png: Buffer.from('test') });
  const backend = { select: async () => ({ handle: 10, pid: 20, title: '独立测试窗口' }), capture: async () => { reads++; return frame(); }, act: async (_frame, _point, args) => { calls++; lastNative = args; }, systemKey: async keys => { calls++; return { executed: true, verified, detail: keys }; } };
  const ctx = { taskId: 'task1', signal: abort.signal, services: { vision: async file => {
    assert.ok(fs.existsSync(file));
    return JSON.stringify(reads === 1 ? { summary: '可见输入框', targets: [{ label: '输入框', x: 500, y: 500 }, { label: '按钮', x: 700, y: 500 }] } : { achieved: verified, detail: verified ? '输入框显示测试文字' : '不能辨认结果' });
  } } };
  const runtime = createComputerTools({ backend, tempDir: dir, now: () => clock, digest: f => f.patch });
  const [observe, action] = runtime.tools;
  return { ctx, observe, action, shellKey: runtime.tools[2], dir, abort, get lastNative() { return lastNative; }, get calls() { return calls; }, set changed(v) { changed = v; }, set moved(v) { moved = v; }, set verified(v) { verified = v; }, set clock(v) { clock = v; } };
}
const observe = async f => (await f.observe.execute({ pid: 20, goal: '输入测试文字' }, f.ctx)).data.observationId;
const args = id => ({ observationId: id, targetId: 't1', action: 'type', text: '测试文字', expected: '输入框显示测试文字' });

test('computer tools always require single-step confirmation', t => {
  const f = fixture(t);
  for (const tool of [f.observe, f.action]) { assert.equal(tool.riskLevel, 'high'); assert.equal(tool.requiresConfirmation, true); }
});
test('observe creates task-bound targets and deletes screenshot files after model call', async t => {
  const f = fixture(t), id = await observe(f);
  assert.ok(id); assert.deepEqual(fs.readdirSync(f.dir), []);
  assert.equal(f.calls, 0);
  assert.throws(() => f.action.assess(args(id), { ...f.ctx, taskId: 'other' }), /不属于/);
});
test('unknown or expired observations never move the mouse', async t => {
  const f = fixture(t), id = await observe(f);
  assert.throws(() => f.action.assess({ ...args(id), targetId: 'made-up' }, f.ctx), /编号不存在/);
  f.clock = 180001;
  await assert.rejects(f.action.execute(args(id), f.ctx), /过期/); assert.equal(f.calls, 0);
});
test('a changed target patch rejects stale visual coordinates', async t => {
  const f = fixture(t), id = await observe(f); f.changed = true;
  await assert.rejects(f.action.execute(args(id), f.ctx), /已变化/); assert.equal(f.calls, 0);
});
test('a moved window rejects the old observation', async t => {
  const f = fixture(t), id = await observe(f); f.moved = true;
  await assert.rejects(f.action.execute(args(id), f.ctx), /已变化/); assert.equal(f.calls, 0);
});
test('one observation allows one action, and post-action vision is required', async t => {
  const f = fixture(t), id = await observe(f), result = await f.action.execute(args(id), f.ctx);
  assert.equal(result.ok, true); assert.equal(result.data.visuallyVerified, true); assert.equal(f.calls, 1);
  await assert.rejects(f.action.execute(args(id), f.ctx), /过期/); assert.equal(f.calls, 1);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
test('an unverified result cannot be reported as success', async t => {
  const f = fixture(t), id = await observe(f); f.verified = false;
  const result = await f.action.execute(args(id), f.ctx);
  assert.equal(result.ok, false); assert.equal(result.data.executed, true); assert.equal(result.data.visuallyVerified, false);
});
test('cancel before action prevents native input', async t => {
  const f = fixture(t), id = await observe(f); f.abort.abort();
  await assert.rejects(f.action.execute(args(id), f.ctx)); assert.equal(f.calls, 0);
});
test('typing cannot smuggle Enter, and key operations stay window-scoped', async t => {
  const f = fixture(t), id = await observe(f);
  assert.throws(() => f.action.assess({ ...args(id), text: 'hello\nsubmit' }, f.ctx), /单行/);
  for (const key of ['alt+tab', 'ctrl+alt+delete', 'win+r', 'ctrl+v', 'ctrl+bogus']) assert.throws(() => keyCodes(key));
  assert.deepEqual(keyCodes('ctrl+a'), [17, 65]); assert.deepEqual(keyCodes('enter'), [13]);
  assert.ok(f.action.assess({ ...args(id), action: 'key', keys: 'enter' }, f.ctx).preview.some(s => s.includes('可能发送')));
});
test('pointer mapping respects normalized coordinates and window bounds', () => {
  assert.deepEqual(physicalPoint({ rect: { left: 100, top: 200, right: 500, bottom: 600 } }, { x: 500, y: 500 }), { x: 300, y: 400 });
  assert.deepEqual(physicalPoint({ rect: { left: 0, top: 0, right: 100, bottom: 100 } }, { x: 1000, y: 1000 }), { x: 99, y: 99 });
});
test('the real executor denial prevents screenshot capture and input', async t => {
  const { ToolExecutor } = require('./app-source/dist-electron/electron/agent/ToolExecutor.js');
  const { ToolRegistry } = require('./app-source/dist-electron/electron/agent/ToolRegistry.js');
  const f = fixture(t), registry = new ToolRegistry(); registry.registerAll([f.observe, f.action]);
  const executor = new ToolExecutor(registry, { authorize: async () => ({ allowed: false, risk: 'high', reason: '用户拒绝' }), resolvePath: p => p }, { verify() { throw new Error('must not verify'); } }, { log() {}, countToolCall() {} }, { text: v => v, value: v => v }, {}, f.ctx.services);
  const result = await executor.run({ id: '1', name: 'computer_observe', arguments: { pid: 20, goal: '测试' } }, { taskId: 'task1', signal: f.ctx.signal, tainted: false, onStep() {} });
  assert.equal(result.status, 'denied'); assert.equal(f.calls, 0); assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('computer use never targets its own authorization windows', async () => {
  const { createWindowsBackend } = require('./computer-use/windows.cjs');
  const row = { pid: process.pid, handle: 123, title: '桌宠聊天' };
  const common = { app: { getAppPath: () => path.join(__dirname, 'app-source') }, platform: { ui: { listWindows: async () => [row] } }, electron: {} };
  await assert.rejects(createWindowsBackend(common).select({ pid: process.pid }), /不能操作桌宠自己/);
  assert.equal((await createWindowsBackend({ ...common, allowedSelfHandles: () => ['123'] }).select({ pid: process.pid, handle: '123' })).handle, 123);
});

test('the persisted computer-use switch removes and restores the tools', t => {
  const { installComputerUse } = require('./computer-use/index.cjs');
  const { ToolRegistry } = require('./app-source/dist-electron/electron/agent/ToolRegistry.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-computer-switch-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = new ToolRegistry(), config = {};
  const runtime = installComputerUse({ app: { getAppPath: () => path.join(__dirname, 'app-source') }, agent: { registry, controller: { deps: { platform: {} }, systemPrompt: () => 'base' } }, config, dataDir: dir, electron: {} });
  assert.equal(registry.has('computer_observe'), true);
  config.updateComputerUseSettings({ enabled: false }); assert.equal(registry.has('computer_observe'), false); assert.equal(config.getComputerUseSettings().enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'computer-use.json'))).enabled, false);
  config.updateComputerUseSettings({ enabled: true }); assert.equal(registry.has('computer_act'), true);
  runtime.close();
});

test('visual scroll supports both axes without a UIA scroll control, verifies result, and consumes observation', async t => {
  const { scrollInput } = require('./computer-use/tools.cjs');
  assert.deepEqual(scrollInput({ direction: 'up', amount: 2 }), { wheel: 240, horizontal: false });
  assert.deepEqual(scrollInput({ direction: 'down' }), { wheel: -360, horizontal: false });
  assert.deepEqual(scrollInput({ direction: 'right', amount: 1 }), { wheel: 120, horizontal: true });
  for (const a of [{ direction: 'down', amount: 0 }, { direction: 'left', amount: 6 }, { direction: 'diagonal' }]) assert.throws(() => scrollInput(a));
  const f = fixture(t), id = await observe(f);
  const a = { ...args(id), action: 'scroll', direction: 'left', amount: 4 };
  assert.equal((await f.action.execute(a, f.ctx)).data.visuallyVerified, true);
  assert.equal(f.lastNative.wheel, -480); assert.equal(f.lastNative.horizontal, true);
  await assert.rejects(f.action.execute(a, f.ctx), /过期/);
});
test('scroll without visible change is reported as unverified', async t => {
  const f = fixture(t), id = await observe(f); f.verified = false;
  const result = await f.action.execute({ ...args(id), action: 'scroll', direction: 'down' }, f.ctx);
  assert.equal(result.ok, false); assert.equal(result.data.executed, true);
});
test('system keys require confirmation, allow only defined shell actions, and invalidate old targets', async t => {
  const { systemKey } = require('./computer-use/tools.cjs');
  assert.equal(systemKey('Windows + E'), 'win+e');
  for (const key of ['win+r', 'win+l', 'win+ctrl+d', 'win+e+enter', 'alt+tab']) assert.throws(() => systemKey(key));
  const f = fixture(t), id = await observe(f);
  assert.equal(f.shellKey.requiresConfirmation, true); assert.equal(f.shellKey.riskLevel, 'high');
  assert.equal((await f.shellKey.execute({ keys: 'win' }, f.ctx)).ok, true);
  await assert.rejects(f.action.execute(args(id), f.ctx), /过期/);
});
test('system key cancellation and denial cause no native input', async t => {
  const f = fixture(t); f.abort.abort();
  await assert.rejects(f.shellKey.execute({ keys: 'win' }, f.ctx)); assert.equal(f.calls, 0);
  const { ToolExecutor } = require('./app-source/dist-electron/electron/agent/ToolExecutor.js');
  const { ToolRegistry } = require('./app-source/dist-electron/electron/agent/ToolRegistry.js');
  const g = fixture(t), registry = new ToolRegistry(); registry.registerAll([g.shellKey]);
  const executor = new ToolExecutor(registry, { authorize: async () => ({ allowed: false, risk: 'high', reason: '用户拒绝' }), resolvePath: p => p }, {}, { log() {}, countToolCall() {} }, { text: v => v, value: v => v }, {}, {});
  assert.equal((await executor.run({ id: '1', name: 'computer_system_key', arguments: { keys: 'win' } }, { taskId: 'task1', signal: g.ctx.signal, tainted: false, onStep() {} })).status, 'denied');
  assert.equal(g.calls, 0);
});
test('system shell mismatch never becomes success', async t => {
  const f = fixture(t); f.verified = false;
  assert.equal((await f.shellKey.execute({ keys: 'win+d' }, f.ctx)).ok, false);
});

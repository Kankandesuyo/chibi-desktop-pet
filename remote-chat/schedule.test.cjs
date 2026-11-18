'use strict';
// The app's scheduler starts runs through send(): it must reach the agent with the run options
// (read-only, unattended, task id), show up in the shared conversation, and refuse while busy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRemoteChat } = require('./server.cjs');

test('send() starts a scheduled run with its options and refuses while busy', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-schedule-test-'));
  let running = false; let seen = null; let cb = null;
  const agent = {
    refreshSecrets() {}, applyGroups() {},
    controller: {
      isRunning: () => running, abort() {}, resolveConfirm: () => false,
      async run(id, history, stats, callbacks, opts) { running = true; seen = { id, history, opts }; cb = callbacks; },
    },
  };
  const config = {
    getSettings: () => ({ petName: '测试', aiEnabled: true }), getAgentSettings: () => ({ enabled: true }),
    getApiKey: () => 'test-secret-api-key-long', getVisionKey: () => '', getStats: () => ({}),
  };
  const runtime = startRemoteChat({ config, agent, windows: { sendToPet() {} }, life: { self: { record() {} }, activity: { streaming: 0 } }, dataDir: dir, port: 17865 });
  await new Promise((resolve) => runtime.server.once('listening', resolve));
  t.after(() => { runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const opts = { readOnly: true, unattended: true, scheduleId: 's1' };
  assert.equal(runtime.send('⏰ 定时任务「早报」：看看下载文件夹', 'schedule', opts), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen.opts, opts);
  assert.equal(seen.history.at(-1).content, '⏰ 定时任务「早报」：看看下载文件夹');
  assert.equal(runtime.send('再来一个', 'schedule', opts), false);       // busy: the scheduler retries later
  cb.emit({ type: 'done', requestId: seen.id, reply: '下载文件夹里有 3 个新文件', emotion: 'neutral', action: 'none', outcome: 'success' });
  running = false;
  assert.equal(runtime.send('第二个', 'schedule'), true);
});

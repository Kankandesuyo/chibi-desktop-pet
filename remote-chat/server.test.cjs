const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startRemoteChat } = require('./server.cjs');

test('authentication, origins, CSRF, live state, confirmations, cancellation and persistence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-remote-test-'));
  let running = false, cb, current, cancelled = false;
  const config = {
    getSettings: () => ({ petName: '测试桌宠', aiEnabled: true }),
    getAgentSettings: () => ({ enabled: true }),
    getApiKey: () => 'test-secret-api-key', getVisionKey: () => '', getStats: () => ({}),
  };
  const agent = { refreshSecrets() {}, applyGroups() {}, controller: {
    isRunning: () => running,
    async run(id, history, stats, callbacks) { running = true; cb = callbacks; current = id; },
    resolveConfirm(id, decision) { if (id !== 'confirm-1') return false; cb.emit({ type: 'confirm-closed', requestId: current }); return true; },
    abort(id) { cancelled = true; running = false; cb.emit({ type: 'error', requestId: id, message: '已取消' }); },
  } };
  const runtime = startRemoteChat({ config, agent, windows: { sendToPet() {} }, life: { self: { record() {} }, activity: { streaming: 0 } }, dataDir: dir, port: 17862 });
  await new Promise(resolve => runtime.server.once('listening', resolve));
  t.after(() => { runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:17862'; let cookie = '', csrf = '';
  async function call(route, body, extra = {}) {
    if (extra.Host) return new Promise((resolve, reject) => {
      const req = http.request(base + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}), Cookie: cookie, ...extra } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve(new Response(text, { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])) })));
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}), Cookie: cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });
    return res;
  }
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await call('/api/login', { password: 'wrong' }, { Origin: 'https://attacker.example' })).status, 403);
  const password = fs.readFileSync(path.join(dir, '访问口令.txt'), 'utf8').split('\n')[1].trim();
  const publicOrigin = 'https://test.trycloudflare.com';
  assert.equal((await call('/', undefined, { Host: 'attacker.example' })).status, 403);
  fs.writeFileSync(path.join(dir, 'origins.json'), '\uFEFF' + JSON.stringify([publicOrigin]));
  const publicHeaders = { Host: 'test.trycloudflare.com', Origin: publicOrigin, 'X-Forwarded-Proto': 'https' };
  const publicLogin = await call('/api/login', { password }, publicHeaders);
  assert.equal(publicLogin.status, 200); assert.match(publicLogin.headers.get('set-cookie'), /; Secure/);
  assert.equal((await call('/api/login', { password }, { ...publicHeaders, 'X-Forwarded-Proto': 'http' })).status, 403);
  const logged = await call('/api/login', { password });
  assert.equal(logged.status, 200); assert.match(logged.headers.get('set-cookie'), /HttpOnly/);
  cookie = logged.headers.get('set-cookie').split(';')[0]; csrf = (await logged.json()).csrf;
  assert.equal((await call('/api/message', { text: 'test' }, { 'X-CSRF-Token': 'bad' })).status, 403);
  const before = await (await call('/api/state')).json();
  const poll = call('/api/state?version=' + before.version);
  assert.equal((await call('/api/message', { text: '<script>hello</script>' })).status, 202);
  assert.equal((await call('/api/message', { text: 'overlap' })).status, 409);
  const state = await (await poll).json(); assert.ok(state.active); assert.equal(state.messages[0].content, '<script>hello</script>');
  cb.emit({ type: 'delta', requestId: current, text: 'hello test-secret-api-key' });
  cb.emit({ type: 'confirm', requestId: current, request: { confirmId: 'confirm-1', title: '写入文件', risk: 'high' } });
  assert.equal((await call('/api/confirm', { id: 'other', decision: 'allow' })).status, 409);
  assert.equal((await call('/api/confirm', { id: 'confirm-1', decision: 'allow_task' })).status, 400);
  assert.equal((await call('/api/confirm', { id: 'confirm-1', decision: 'deny' })).status, 200);
  const delta = await (await call('/api/state')).json(); assert.match(delta.active.text, /已隐藏密钥/);
  await call('/api/abort', {}); assert.ok(cancelled);
  const after = await (await call('/api/state')).json(); assert.equal(after.active, null); assert.equal(after.messages.at(-1).content, '已取消');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'shared-history.json'))).messages.length, 2);
  assert.equal((await call('/../server.cjs')).status, 404);
  await call('/api/logout', {}); assert.equal((await call('/api/state')).status, 401);
});

test('desktop and web share history, live task state and versioned settings', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-shared-test-'));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([{ role: 'user', content: '旧网页消息', time: 123 }]));
  let basic = { petName: 'kk', personaTraits: '温柔', aiEnabled: true, monologue: 'normal', size: .8, opacity: 1, speed: 1, autoMoveFrequency: .5, autoMove: true, sound: false };
  let agentSettings = { enabled: true, maxSteps: 25, toolProtocol: 'auto' };
  let endpoint = { baseUrl: 'https://example.com/v1', model: 'model' }, mirror = [], running = false, callback, id;
  const config = {
    getSettings: () => ({ ...basic, ai: { ...endpoint, apiKey: 'secret-should-never-leave' } }),
    getAgentSettings: () => ({ ...agentSettings }), getAiEndpoint: () => ({ ...endpoint }),
    getApiKey: () => 'secret-should-never-leave', getVisionKey: () => '', getStats: () => ({}),
    getChatHistory: () => [{ role: 'assistant', content: '旧桌面消息' }], setChatHistory: h => { mirror = h; },
    updateSettings: patch => { basic = { ...basic, ...patch }; },
    updateAgent: patch => { agentSettings = { ...agentSettings, ...patch }; },
    updateAi: patch => { endpoint = { ...endpoint, ...patch }; },
  };
  const handlers = new Map(), broadcasts = [];
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) };
  const windows = { allWebContentsIds: () => [7], sendToPet() {}, broadcast: (channel, payload) => broadcasts.push([channel, payload]) };
  const agent = { refreshSecrets() {}, applyGroups() {}, controller: {
    isRunning: () => running,
    async run(requestId, history, stats, cb) { id = requestId; callback = cb; running = true; },
    abort() { running = false; callback.emit({ type: 'error', requestId: id, message: '已取消' }); },
  } };
  const rt = startRemoteChat({ config, agent, windows, ipcMain, life: { self: { record() {} }, activity: { streaming: 0 } }, dataDir: dir, port: 17863 });
  await new Promise(resolve => rt.server.once('listening', resolve));
  t.after(() => { rt.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const desktop = (channel, ...args) => handlers.get(channel)({ sender: { id: 7 } }, ...args);
  const initial = desktop('chat:shared-state'); assert.deepEqual(initial.messages.map(m => m.content), ['旧桌面消息', '旧网页消息']);
  assert.ok(fs.existsSync(path.join(dir, 'before-sync-migration.json')));
  assert.ok(handlers.get('chat:shared-send')({ sender: { id: 99 } }, 'unauthorized').error);
  const base = 'http://127.0.0.1:17863';
  const password = fs.readFileSync(path.join(dir, '访问口令.txt'), 'utf8').split('\n')[1].trim();
  const logged = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = logged.headers.get('set-cookie').split(';')[0], csrf = (await logged.json()).csrf;
  const web = (route, data) => fetch(base + route, { method: data ? 'POST' : 'GET', headers: { Cookie: cookie, ...(data ? { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) }, body: data ? JSON.stringify(data) : undefined });
  desktop('chat:shared-send', '桌面发出');
  let state = await (await web('/api/state')).json(); assert.equal(state.messages.at(-1).content, '桌面发出'); assert.equal(state.active.source, 'desktop');
  assert.equal((await web('/api/message', { text: '并发消息' })).status, 409);
  callback.emit({ type: 'delta', requestId: id, text: '正在回复' });
  assert.equal((await (await web('/api/state')).json()).active.text, '正在回复');
  assert.doesNotThrow(() => structuredClone(desktop('chat:shared-state')));
  callback.emit({ type: 'done', requestId: id, reply: '桌面回复', outcome: 'chat' }); running = false;
  await web('/api/message', { text: '网页发出' });
  assert.equal(desktop('chat:shared-state').messages.at(-1).content, '网页发出');
  const conf = { confirmId: 'c1', title: '确认', risk: 'medium' };
  callback.emit({ type: 'confirm', requestId: id, request: conf });
  assert.deepEqual(desktop('chat:shared-state').active.confirm, conf);
  const oldSettings = await (await web('/api/settings')).json();
  assert.ok(!JSON.stringify(oldSettings).includes('secret-should-never-leave'));
  assert.equal((await web('/api/settings', { revision: oldSettings.revision, settings: { petName: 'task' } })).status, 409);
  callback.emit({ type: 'done', requestId: id, reply: '网页回复', outcome: 'chat' }); running = false;
  assert.equal(desktop('chat:shared-state').messages.at(-1).content, '网页回复'); assert.equal(mirror.at(-1).content, '网页回复');
  const settingsResult = await web('/api/settings', { revision: oldSettings.revision, settings: { petName: '新名字', personaTraits: '保持温柔', character: 'deepseek', size: 1, agentEnabled: false } });
  assert.equal(settingsResult.status, 200); assert.equal(config.getSettings().petName, '新名字'); assert.equal(config.getAgentSettings().enabled, false);
  assert.equal(config.getSettings().character, 'deepseek');
  assert.equal((await (await web('/api/state')).json()).character, 'deepseek');
  assert.equal(desktop('chat:shared-state').character, 'deepseek');
  assert.equal((await web('/api/settings', { revision: oldSettings.revision, settings: { petName: '旧页面' } })).status, 409);
  const fresh = await (await web('/api/settings')).json();
  assert.equal(fresh.settings.character, 'deepseek');
  assert.equal((await web('/api/settings', { revision: fresh.revision, settings: { character: '../../private', petName: '不能部分保存' } })).status, 400);
  assert.equal(config.getSettings().character, 'deepseek');
  assert.equal((await web('/api/settings', { revision: fresh.revision, settings: { petName: '不能部分保存', ai: { baseUrl: 'https://other.example/v1' } } })).status, 400);
  assert.equal(config.getSettings().petName, '新名字');
  assert.equal((await web('/api/settings', { revision: fresh.revision, settings: { fullDiskAccess: true } })).status, 400);
  config.updateSettings({ petName: '电脑端修改', character: 'orange' });
  assert.equal((await (await web('/api/state')).json()).name, '电脑端修改');
  assert.equal((await (await web('/api/state')).json()).character, 'orange');
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.ok(broadcasts.some(([channel, value]) => channel === 'evt:shared-chat' && value.messages.at(-1).content === '网页回复'));
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { decodeUpload } = require('./image-input.cjs');
const { validateSettings, readSettings } = require('./web-settings.cjs');
const { startRemoteChat } = require('./server.cjs');
const png = fs.readFileSync(path.join(__dirname, 'tests/vision-check.png'));
const upload = { name: 'test.png', dataUrl: 'data:image/png;base64,' + png.toString('base64') };
const normalize = buffer => ({ buffer, width: 720, height: 420 });

test('image content and size validation precede native decoding', () => {
  assert.equal(decodeUpload(upload, normalize).width, 720);
  const jpeg = fs.readFileSync(path.join(__dirname, 'tests/vision-check.jpg'));
  assert.equal(decodeUpload({ name: 'test.jpg', dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64') }, normalize).height, 420);
  assert.throws(() => decodeUpload({ dataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') }, normalize));
  assert.throws(() => decodeUpload({ dataUrl: 'data:image/png;base64,AAAA' }, normalize));
  const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16);
  let decoded = false;
  assert.throws(() => decodeUpload({ dataUrl: 'data:image/png;base64,' + bomb.toString('base64') }, () => { decoded = true; }));
  assert.equal(decoded, false);
  assert.throws(() => decodeUpload({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024) }, normalize));
});

test('vision keys are write-only and cannot follow an endpoint to a different provider', () => {
  const config = { getSettings: () => ({}), getAgentSettings: () => ({ vision: { baseUrl: '', model: 'deepseek-flash' } }), getAiEndpoint: () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'must-not-leak' }), getApiKey: () => 'chat-secret', getVisionKey: () => '' };
  assert.ok(!JSON.stringify(readSettings(config)).includes('must-not-leak'));
  assert.ok(!JSON.stringify(readSettings(config)).includes('chat-secret'));
  assert.equal(validateSettings({ vision: { model: 'deepseek-flash', baseUrl: '', apiKey: '' } }, config).agent.vision.model, 'deepseek-flash');
  assert.throws(() => validateSettings({ vision: { baseUrl: 'https://other.example' } }, config), /共用聊天密钥/);
  assert.throws(() => validateSettings({ vision: { baseUrl: 'http://other.example', apiKey: 'new-key' } }, config), /HTTPS/);
  assert.equal(validateSettings({ vision: { baseUrl: 'https://other.example', apiKey: 'new-key' } }, config).agent.vision.apiKey, 'new-key');
});

test('image questions use vision only, share results, protect files, and support cancellation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-vision-test-'));
  let calls = 0, endpoint, question;
  const config = { getSettings: () => ({ petName: 'kk', aiEnabled: true }), getAgentSettings: () => ({ enabled: true, vision: { model: 'deepseek-flash' } }), getApiKey: () => 'chat-secret', getVisionKey: () => '', getVisionEndpoint: () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'chat-secret' }), getChatHistory: () => [], setChatHistory() {}, getStats: () => ({}) };
  const agent = { refreshSecrets() {}, applyGroups() {}, controller: { isRunning: () => false, run() { throw new Error('Image content must never execute tools'); }, abort() {} } };
  let finish;
  const rt = startRemoteChat({ config, agent, windows: { sendToPet() {} }, life: { persona: () => '你是 kk。', self: { record() {} }, activity: { streaming: 0 } }, dataDir: dir, port: 17864, normalizeImage: normalize, describeImage: async (ep, buffer, ask, signal) => {
    calls++; endpoint = ep; question = ask; assert.ok(buffer.equals(png));
    return new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true }); });
  } });
  await new Promise(resolve => rt.server.once('listening', resolve));
  t.after(() => { rt.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:17864';
  const password = fs.readFileSync(path.join(dir, '访问口令.txt'), 'utf8').split('\n')[1].trim();
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrf;
  const call = (route, data) => fetch(base + route, { method: data ? 'POST' : 'GET', headers: { Cookie: cookie, ...(data ? { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) }, body: data ? JSON.stringify(data) : undefined });
  assert.equal((await call('/api/message', { text: '读图', image: { dataUrl: 'bad' } })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await call('/api/message', { text: '数字是什么？', image: upload })).status, 202);
  let state = await (await call('/api/state')).json(); assert.equal(state.active.mode, 'vision'); assert.equal(endpoint.model, 'deepseek-flash'); assert.match(question, /数字是什么/);
  const imageId = state.messages[0].image.id;
  assert.equal((await fetch(base + '/api/images/' + imageId)).status, 401);
  assert.equal((await call('/api/images/' + 'a'.repeat(64))).status, 404);
  assert.ok(Buffer.from(await (await call('/api/images/' + imageId)).arrayBuffer()).equals(png));
  finish('4821，红色方形、蓝色圆形、绿色三角形。');
  await new Promise(resolve => setImmediate(resolve));
  state = await (await call('/api/state')).json(); assert.equal(state.active, null); assert.match(state.messages.at(-1).content, /4821/);
  assert.equal((await call('/api/message', { text: '', image: upload })).status, 202);
  await call('/api/abort', {}); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await (await call('/api/state')).json()).messages.at(-1).content, '已取消');
});

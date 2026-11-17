'use strict';
// Harness phase 2 endpoints: sessions, trajectory, slash commands, and the local CLI token.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startRemoteChat } = require('./server.cjs');

const PORT = 17863;

function fakeSessions() {
  const store = { a: [], b: [] };
  let current = 'a';
  return {
    get id() { return current; },
    list: () => Object.keys(store).map((id) => ({ id, title: store[id][0]?.content || '新会话', updatedAt: 0, current: id === current })),
    switchTo: (id) => { if (!store[id]) return false; current = id; return true; },
    chat: () => store[current],
    turns: () => [{ stats: { steps: 2, toolCalls: 1, llmMs: 1500, toolMs: 20, inputTokens: 900, outputTokens: 40, cachedTokens: 600 } }],
    events: () => [{ seq: 1, type: 'turn/start', userText: 'key=test-secret-api-key' }],
    store,
  };
}

test('sessions, trajectory, commands and the CLI token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-sessions-test-'));
  const sessions = fakeSessions();
  const config = {
    getSettings: () => ({ petName: '测试', aiEnabled: true }), getAgentSettings: () => ({ enabled: true }),
    getApiKey: () => 'test-secret-api-key', getVisionKey: () => '', getStats: () => ({}),
  };
  const agent = {
    refreshSecrets() {}, applyGroups() {}, sessions,
    command: (text) => (text.startsWith('/status') ? { reply: '会话：a' } : null),
    controller: { isRunning: () => false, async run() {}, resolveConfirm: () => false, abort() {} },
  };
  // Conversation backed by the fake session store (what the app passes in).
  const conversation = (onChange) => ({
    get messages() { return sessions.chat(); },
    append(m) { sessions.store[sessions.id].push(m); onChange(); },
    clear() { sessions.store.c = []; sessions.switchTo('c'); onChange(); },
    persist() {},
  });
  const runtime = startRemoteChat({ config, agent, windows: { sendToPet() {} }, life: { self: { record() {} }, activity: { streaming: 0 } }, dataDir: dir, port: PORT, conversation });
  await new Promise((resolve) => runtime.server.once('listening', resolve));
  t.after(() => { runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const token = fs.readFileSync(path.join(dir, 'cli-token.txt'), 'utf8').trim();
  const base = `http://127.0.0.1:${PORT}`;
  const req = (route, { body, headers = {}, host } = {}) => new Promise((resolve, reject) => {
    const r = http.request(base + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(host ? { Host: host } : {}), ...headers } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(text || '{}') }));
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
  const auth = { Authorization: `Bearer ${token}` };

  // No token / wrong token / token through the public tunnel host: refused.
  assert.equal((await req('/api/sessions')).status, 401);
  assert.equal((await req('/api/sessions', { headers: { Authorization: `Bearer ${'x'.repeat(token.length)}` } })).status, 401);
  fs.writeFileSync(path.join(dir, 'origins.json'), JSON.stringify(['https://pet.example.com']));
  assert.equal((await req('/api/sessions', { headers: { ...auth, 'X-Forwarded-Proto': 'https' }, host: 'pet.example.com' })).status, 401);

  // With the token on 127.0.0.1: no cookie, no CSRF needed.
  const list = await (await req('/api/sessions', { headers: auth })).json();
  assert.equal(list.current, 'a');
  assert.deepEqual(list.sessions.map((s) => s.id), ['a', 'b']);
  const state = await (await req('/api/state', { headers: auth })).json();
  assert.equal(state.session.id, 'a');
  assert.deepEqual(state.session.stats.total, { turns: 1, steps: 2, toolCalls: 1, llmMs: 1500, toolMs: 20, inputTokens: 900, outputTokens: 40, cachedTokens: 600, hasTokens: true });

  assert.equal((await req('/api/sessions/open', { body: { id: 'b' }, headers: auth })).status, 200);
  assert.equal(sessions.id, 'b');
  assert.equal((await req('/api/sessions/open', { body: { id: 'nope' }, headers: auth })).status, 404);
  assert.equal((await req('/api/sessions/new', { body: {}, headers: auth })).status, 200);
  assert.equal(sessions.id, 'c');

  const traj = await (await req('/api/trajectory', { headers: auth })).json();
  assert.equal(traj.events.length, 1);
  assert.doesNotMatch(JSON.stringify(traj), /test-secret-api-key/);

  assert.deepEqual(await (await req('/api/command', { body: { text: '/status' }, headers: auth })).json(), { reply: '会话：a' });
  assert.deepEqual(await (await req('/api/command', { body: { text: '你好' }, headers: auth })).json(), { notCommand: true });
});

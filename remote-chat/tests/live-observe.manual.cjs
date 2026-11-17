'use strict';
// Manual live regression. Only permits an observation of the project's own
// synthetic demo; any action/other-window confirmation aborts the test.
const fs = require('node:fs'), path = require('node:path');
(async () => {
  const pid = Number(process.argv[2]); if (!Number.isInteger(pid) || pid <= 0) throw new Error('Pass the current desktop pet process ID');
  const base = 'http://127.0.0.1:17861', dir = path.join(process.env.APPDATA, 'chibi-desktop-pet/remote-chat');
  const password = fs.readFileSync(path.join(dir, '访问口令.txt'), 'utf8').split('\n')[1].trim();
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrf;
  const call = async (route, value) => {
    const r = await fetch(base + route, { method: value ? 'POST' : 'GET', headers: { Cookie: cookie, ...(value ? { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) }, body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.timeout(30000) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || String(r.status)); return j;
  };
  const job = await call('/api/message', { text: `只读回归：刚重新打开了“桌宠电脑操作测试”这个独立合成测试窗口。它与桌宠同进程 PID ${pid}，但有不同窗口 handle。请按标题选择这个测试窗口，调用 computer_observe 一次，识别加一按钮和测试输入框，报告结果即可。不要点击、输入、登录、发消息或观察微信；不要观察桌宠聊天/设置窗口。` });
  let version = -1, approved = false; const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const state = await call('/api/state?version=' + version); version = state.version;
    const reply = state.messages.find(m => m.id === job.id);
    if (reply) {
      const observations = reply.steps.filter(s => s.tool === 'computer_observe');
      if (reply.failed || observations.length !== 1 || observations[0].status !== 'ok') throw new Error('Observation regression failed: ' + reply.content);
      const output = { ok: true, steps: observations.map(s => ({ tool: s.tool, status: s.status, summary: s.summary })) };
      fs.writeFileSync(path.join(__dirname, '../outputs/computer-vision-fix-regression.json'), JSON.stringify(output, null, 2));
      console.log(JSON.stringify(output)); return;
    }
    const c = state.active?.id === job.id && state.active.confirm;
    if (c) {
      if (approved || c.tool !== 'computer_observe' || c.preview?.[0] !== `窗口：桌宠电脑操作测试（PID ${pid}）`) { await call('/api/abort', {}); throw new Error('Unexpected confirmation: test aborted'); }
      await call('/api/confirm', { id: c.confirmId, decision: 'allow' }); approved = true;
    }
  }
  throw new Error('Timed out');
})().catch(error => { console.error(error.message); process.exitCode = 1; });

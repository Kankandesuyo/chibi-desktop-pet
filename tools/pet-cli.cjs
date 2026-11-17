#!/usr/bin/env node
'use strict';
/**
 * Command line front-end for the desktop pet (same runtime, session and permissions as the chat window).
 *
 *   pet 帮我把下载文件夹整理一下      send a message and follow the task (confirmations are asked here)
 *   pet /status   pet /resume …      slash commands
 *   pet status | sessions | open <id> | new | stop
 *
 * Talks to the pet's local service on 127.0.0.1 with the token in
 * %APPDATA%\chibi-desktop-pet\remote-chat\cli-token.txt (readable only by this Windows account).
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const PORT = Number(process.env.PET_PORT || 17861);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = process.env.PET_DATA_DIR || path.join(process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming'), 'chibi-desktop-pet', 'remote-chat');

function token() {
  try { return fs.readFileSync(path.join(dataDir, 'cli-token.txt'), 'utf8').trim(); } catch {
    fail('找不到桌宠的本地令牌。请先启动桌宠（新版本），再试一次。');
  }
}
class CliError extends Error {}
function fail(msg) { throw new CliError(msg); }

/**
 * Answers typed (or piped) on stdin, one line per question. Lines are buffered as they arrive, so piped
 * answers work too; when stdin has ended, a question gets '' (= deny).
 */
function createAsker() {
  const lines = []; const waiting = []; let ended = false;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
  rl.on('close', () => { ended = true; for (const w of waiting.splice(0)) w(''); });
  return {
    question(prompt) {
      process.stdout.write(prompt);
      if (lines.length) { const l = lines.shift(); process.stdout.write(`${l}\n`); return Promise.resolve(l); }
      if (ended) { process.stdout.write('（没有输入，按拒绝处理）\n'); return Promise.resolve(''); }
      return new Promise((r) => waiting.push(r));
    },
    close() { rl.close(); },
  };
}

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(BASE + route, {
      method, headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { fail('连不上桌宠。请确认桌宠正在运行。'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error || `请求失败（${res.status}）`);
  return data;
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

function printStats(st) {
  if (!st) return;
  const t = st.total;
  const parts = [`${t.turns} 回合 · ${t.steps} 步`, `模型 ${fmtMs(t.llmMs)} · 工具 ${fmtMs(t.toolMs)}`];
  if (t.hasTokens) parts.push(`输入 ${fmtTok(t.inputTokens)} · 输出 ${fmtTok(t.outputTokens)}${t.cachedTokens ? ` · 缓存命中 ${Math.round((t.cachedTokens / Math.max(1, t.inputTokens)) * 100)}%` : ''}`);
  console.log(parts.join(' | '));
}

async function follow(rl) {
  // Long-poll the shared state until the task this CLI started has finished.
  let state = await api('GET', '/api/state');
  const seenSteps = new Map();
  const asked = new Set();
  let printed = '';
  for (;;) {
    const a = state.active;
    if (!a) break;
    for (const step of a.steps || []) {
      const key = `${step.stepId}:${step.status}`;
      if (seenSteps.has(key) || step.status === 'running' || step.status === 'waiting' || step.tool === 'update_plan') continue;
      seenSteps.set(key, true);
      const icon = { ok: '✓', failed: '✗', denied: '⊘' }[step.status] || '·';
      console.log(`  ${icon} ${step.title}${step.summary ? ` — ${step.summary}` : ''}`);
    }
    if (a.text && a.text !== printed) { printed = a.text; }
    if (a.confirm && !asked.has(a.confirm.confirmId)) {
      asked.add(a.confirm.confirmId);
      const c = a.confirm;
      console.log(`\n需要确认（${{ low: '低', medium: '中', high: '高' }[c.risk] || c.risk}风险）：${c.title}\n  ${c.reason}`);
      for (const line of c.preview || []) console.log(`  │ ${line}`);
      const answer = (await rl.question('允许吗？[y/N] ')).trim().toLowerCase();
      await api('POST', '/api/confirm', { id: c.confirmId, decision: answer === 'y' || answer === 'yes' ? 'allow' : 'deny' });
    }
    state = await api('GET', `/api/state?version=${state.version}`);
  }
  const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
  // Steps that finished between two polls are only in the final message.
  for (const step of last?.steps || []) {
    if (step.tool === 'update_plan' || [...seenSteps.keys()].some((k) => k.startsWith(`${step.stepId}:`))) continue;
    console.log(`  ${{ ok: '✓', failed: '✗', denied: '⊘' }[step.status] || '·'} ${step.title}${step.summary ? ` — ${step.summary}` : ''}`);
  }
  if (last) console.log(`\n${state.name || '她'}：${last.content}`);
  printStats(state.session?.stats);
}

async function send(text) {
  const rl = createAsker();
  try {
    await api('POST', '/api/message', { text });
    await follow(rl);
  } finally { rl.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    console.log(['用法：', '  pet <消息>            让她聊天或做事（需要确认时在这里回答）', '  pet /help             斜杠命令（/status /resume /new /tools…）',
      '  pet status            当前会话和状态', '  pet sessions          列出会话', '  pet open <会话ID>     切换到某个会话', '  pet new               开始新会话', '  pet stop              停止当前任务'].join('\n'));
    return;
  }
  const [cmd, ...rest] = args;
  if (cmd === 'status') {
    const s = await api('GET', '/api/state');
    console.log(`会话：${s.session?.id ?? '—'}　${s.active ? `正在做：${s.active.mode}` : '空闲'}`);
    printStats(s.session?.stats);
  } else if (cmd === 'sessions') {
    const r = await api('GET', '/api/sessions');
    for (const x of r.sessions) console.log(`${x.current ? '▶' : ' '} ${x.id}  ${new Date(x.updatedAt).toLocaleString('zh-CN', { hour12: false })}  ${x.title}`);
  } else if (cmd === 'open') {
    if (!rest[0]) fail('请给出会话 ID（pet sessions 可以看到）');
    await api('POST', '/api/sessions/open', { id: rest[0] });
    console.log('已切换。');
  } else if (cmd === 'new') {
    await api('POST', '/api/sessions/new', {});
    console.log('已开始新会话。');
  } else if (cmd === 'stop') {
    await api('POST', '/api/abort', {});
    console.log('已请求停止。');
  } else if (cmd.startsWith('/')) {
    const r = await api('POST', '/api/command', { text: args.join(' ') });
    if (r.notCommand) return send(args.join(' '));
    console.log(r.reply);
    if (r.action === 'send' && r.prompt) await send(r.prompt);
  } else {
    await send(args.join(' '));
  }
}

main().catch((err) => {
  console.error(err instanceof CliError ? err.message : `出错了：${err.message}`);
  process.exitCode = 1;
}).finally(() => { process.stdin.unref?.(); });

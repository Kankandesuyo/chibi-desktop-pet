import { app, BrowserWindow, screen } from 'electron';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CHARACTERS } from '../shared/characters';
import { IPC } from '../shared/constants';
import type { ConfigStore } from './configStore';
const IPC_SETTINGS = IPC.settings;
import type { WindowManager } from './windowManager';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Scripted end-to-end run against the real windows (development only, see docs/VERIFICATION.md).
 * Mouse input is injected into the page, and the cursor position used for dragging is scripted
 * (a virtual display has no real mouse). Writes screenshots and a log.json into `dir`.
 */
export async function runSmokeScenario(windows: WindowManager, dir: string, quit: () => void, config: ConfigStore): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const log: Record<string, unknown>[] = [];
  const pet = windows.pet;
  if (!pet) { quit(); return; }
  const wc = pet.webContents;
  const errors: string[] = [];
  wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  wc.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));

  const cursor = { ...screen.getCursorScreenPoint() };
  windows.cursorProvider = () => ({ ...cursor });
  const snap = async (name: string): Promise<void> => {
    const state = (await wc.executeJavaScript('document.body.dataset.petState')) as string | undefined;
    fs.writeFileSync(path.join(dir, `${name}.png`), (await wc.capturePage()).toPNG());
    log.push({ step: name, state, bounds: pet.getBounds(), cursor: { ...cursor }, windows: BrowserWindow.getAllWindows().length });
  };
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number, clickCount = 1): void => {
    wc.sendInputEvent({ type, x, y, button: 'left', clickCount });
  };

  await sleep(3500);
  const b = pet.getBounds();
  const body = { x: Math.round(b.width / 2), y: Math.round(b.height * 0.62) };
  const head = { x: Math.round(b.width / 2), y: Math.round(b.height * 0.42) };
  await snap('1_start');

  mouse('mouseMove', body.x, body.y); await sleep(100);
  mouse('mouseDown', body.x, body.y); await sleep(60); mouse('mouseUp', body.x, body.y);
  await sleep(600); await snap('2_single_click');
  await sleep(2500);

  for (let i = 0; i < 60; i++) { mouse('mouseMove', head.x + Math.round(Math.sin(i / 3) * 16), head.y); await sleep(25); }
  await snap('3_petting');
  await sleep(2500);

  mouse('mouseMove', body.x, body.y); await sleep(100);
  mouse('mouseDown', body.x, body.y); await sleep(50);
  mouse('mouseMove', body.x + 14, body.y - 10); await sleep(50);
  await sleep(300);
  for (let i = 0; i < 40; i++) { cursor.x -= 9; cursor.y -= 11; await sleep(16); }      // lift her up and to the left
  await sleep(200); await snap('4_dragging');
  for (let i = 0; i < 30; i++) { cursor.x += i % 10 < 5 ? 14 : -14; await sleep(16); } // shake
  await snap('4b_shaking');
  await sleep(2800); await snap('5_struggling');
  cursor.x -= 5000; cursor.y -= 5000; await sleep(200); await snap('5b_dragged_past_corner');
  cursor.x += 5000 - 300; cursor.y += 5000 - 100; await sleep(200);
  mouse('mouseUp', body.x + 14, body.y - 10);
  await sleep(150); await snap('6_falling');
  await sleep(1800); await snap('7_landed');
  await sleep(3000);

  mouse('mouseMove', body.x, body.y); await sleep(100);
  mouse('mouseDown', body.x, body.y, 1); mouse('mouseUp', body.x, body.y, 1); await sleep(90);
  mouse('mouseDown', body.x, body.y, 2); mouse('mouseUp', body.x, body.y, 2);
  await sleep(450); await snap('8_double_click');
  await sleep(1200);
  const chat = BrowserWindow.getAllWindows().find((w) => w !== pet);
  if (chat) fs.writeFileSync(path.join(dir, '9_chat.png'), (await chat.webContents.capturePage()).toPNG());
  log.push({ step: '9_chat', chatOpen: Boolean(chat), chatBounds: chat?.getBounds() });

  // ---- files dropped on her ----
  // A synthetic drop (a File made in the page has no real path): she must take it on her body only and
  // say she could not get a real file. Then the chat gets a "these files" hand-off and shows the chip.
  const dropAt = (x: number, y: number): Promise<unknown> => wc.executeJavaScript(`(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt'));
    const ev = (t) => new DragEvent(t, { clientX: ${x}, clientY: ${y}, dataTransfer: dt, bubbles: true, cancelable: true });
    const over = ev('dragover'); window.dispatchEvent(over);
    window.dispatchEvent(ev('drop'));
    return over.defaultPrevented;
  })()`);
  const acceptedOff = await dropAt(2, 2);
  await sleep(200);
  const bubbleOff = (await wc.executeJavaScript('document.querySelector(".pet-bubble")?.textContent ?? ""')) as string;
  const acceptedOn = await dropAt(body.x, body.y);
  await sleep(300);
  const bubbleOn = (await wc.executeJavaScript('document.querySelector(".pet-bubble")?.textContent ?? ""')) as string;
  await snap('9b_file_drop');
  let chipText = '';
  if (chat) {
    windows.composeInChat({ paths: [path.join(app.getPath('desktop'), '某个文件.txt'), path.join(app.getPath('desktop'), '另一个.png')], hint: '想让她对这些文件做什么？' });
    await sleep(600);
    chipText = (await chat.webContents.executeJavaScript('document.querySelector(".chat-attach span")?.textContent ?? ""')) as string;
    const placeholder = (await chat.webContents.executeJavaScript('document.querySelector(".chat-form input")?.placeholder ?? ""')) as string;
    fs.writeFileSync(path.join(dir, '9c_chat_attach.png'), (await chat.webContents.capturePage()).toPNG());
    log.push({ step: '9c_chat_attach', chipText, placeholder });
    await chat.webContents.executeJavaScript('document.querySelector(".chat-attach button")?.click(); "ok"');
  }
  log.push({ step: '9b_file_drop', acceptedOff, bubbleOff, acceptedOn, bubbleOn });

  // ---- agent mode, end to end through the real IPC, against a scripted OpenAI-compatible server ----
  if (chat) {
    const target = path.join(app.getPath('desktop'), '智能体冒烟测试');
    fs.rmSync(target, { recursive: true, force: true });
    const turns = [
      { tool: ['update_plan', { steps: [{ title: '找到桌面', status: 'in_progress' }, { title: '新建文件夹', status: 'pending' }] }] },
      { tool: ['get_known_folders', {}] },
      { tool: ['create_directory', { path: target }], text: '我来建～' },
      { text: '建好啦，就在桌面上！[[emotion:happy|action:wave]]' },
    ];
    let n = 0;
    const requests: { tools: number; roles: string[]; persona: boolean }[] = [];
    const server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw) as { tools?: unknown[]; messages: { role: string; content?: unknown }[] };
        requests.push({ tools: body.tools?.length ?? 0, roles: body.messages.map((m) => m.role), persona: String(body.messages[0]?.content ?? '').includes('你叫「') });
        const t = turns[Math.min(n++, turns.length - 1)] as { tool?: [string, unknown]; text?: string };
        const chunks: unknown[] = [];
        if (t.text) chunks.push({ choices: [{ delta: { content: t.text } }] });
        if (t.tool) chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: t.tool[0], arguments: JSON.stringify(t.tool[1]) } }] } }] });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    config.updateSettings({ aiEnabled: true });
    config.updateAi({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'mock', apiKey: 'sk-smoketestkey000000000000' });
    windows.applySettingsToWindows();
    windows.broadcast(IPC_SETTINGS, config.getSettings());
    await sleep(500);
    await chat.webContents.executeJavaScript(`
      window.__agent = { events: [] };
      window.petAPI.onAgentEvent((e) => { window.__agent.events.push(e.type); if (e.type === 'confirm') window.__agent.confirm = e.request; });
      void window.petAPI.getInitialData().then(() => {});
      'ok'`);
    // Type into the real chat box and submit, like a user would.
    await chat.webContents.executeJavaScript(`
      (async () => {
        for (let i = 0; i < 20 && !document.querySelector('.chat-form input'); i++) await new Promise((r) => setTimeout(r, 100));
        const input = document.querySelector('.chat-form input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '帮我在桌面建一个叫 智能体冒烟测试 的文件夹');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        document.querySelector('.chat-form button[type=submit]').click();
        return 'sent';
      })()`);
    let confirmSeen = false;
    for (let i = 0; i < 60 && !confirmSeen; i++) { await sleep(200); confirmSeen = (await chat.webContents.executeJavaScript('Boolean(document.querySelector(".confirm"))')) as boolean; }
    const existedBeforeApproval = fs.existsSync(target);
    fs.writeFileSync(path.join(dir, '11_agent_confirm.png'), (await chat.webContents.capturePage()).toPNG());
    await chat.webContents.executeJavaScript('document.querySelector(".confirm .ok")?.click(); "clicked"');
    let done = false;
    for (let i = 0; i < 60 && !done; i++) { await sleep(200); done = (await chat.webContents.executeJavaScript('window.__agent.events.includes("done") || window.__agent.events.includes("error")')) as boolean; }
    await sleep(600);
    fs.writeFileSync(path.join(dir, '12_agent_done.png'), (await chat.webContents.capturePage()).toPNG());
    await chat.webContents.executeJavaScript('document.querySelector(".agent-done-steps")?.setAttribute("open", ""); "ok"');
    await sleep(200);
    fs.writeFileSync(path.join(dir, '13_agent_steps.png'), (await chat.webContents.capturePage()).toPNG());
    const events = (await chat.webContents.executeJavaScript('window.__agent.events')) as string[];
    const petState = (await wc.executeJavaScript('document.body.dataset.petState')) as string;
    log.push({ step: '11_agent', confirmSeen, existedBeforeApproval, folderCreated: fs.existsSync(target), events, modelRequests: requests, petStateAfter: petState });
    fs.rmSync(target, { recursive: true, force: true });
    server.close();
    // chat window controls
    const b0 = chat.getBounds();
    await chat.webContents.executeJavaScript('window.petAPI.panelControl("bigger")');
    await sleep(400);
    const b1 = chat.getBounds();
    fs.writeFileSync(path.join(dir, '15_chat_bigger.png'), (await chat.webContents.capturePage()).toPNG());
    await chat.webContents.executeJavaScript('window.petAPI.panelControl("smaller")');
    await chat.webContents.executeJavaScript('window.petAPI.panelControl("smaller")');
    await sleep(400);
    const b2 = chat.getBounds();
    fs.writeFileSync(path.join(dir, '16_chat_smaller.png'), (await chat.webContents.capturePage()).toPNG());
    const pinnedBefore = chat.isAlwaysOnTop();
    await chat.webContents.executeJavaScript('window.petAPI.panelControl("toggle-pin")');
    const pinnedAfter = chat.isAlwaysOnTop();
    await chat.webContents.executeJavaScript('document.querySelector(".chat-head-actions button:last-child").click()');
    await sleep(300);
    chat.webContents.send('noop');
    const g = (await chat.webContents.executeJavaScript('(() => { const r = document.querySelector(".resize-grip").getBoundingClientRect(); return [r.x + 8, r.y + 8]; })()')) as [number, number];
    const before = chat.getBounds();
    await chat.webContents.executeJavaScript(`window.__grip=[]; const gg=document.querySelector('.resize-grip'); ['pointerdown','pointermove','pointerup','mousedown','mousemove'].forEach(t=>gg.addEventListener(t,e=>window.__grip.push(t+':'+e.screenX))); document.addEventListener('pointermove',e=>window.__grip.push('doc:'+e.screenX)); 'ok'`);
    const wb = chat.getBounds();
    chat.webContents.sendInputEvent({ type: 'mouseDown', x: g[0], y: g[1], globalX: wb.x + g[0], globalY: wb.y + g[1], button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) { chat.webContents.sendInputEvent({ type: 'mouseMove', x: g[0] + i * 12, y: g[1] + i * 9, globalX: wb.x + g[0] + i * 12, globalY: wb.y + g[1] + i * 9, button: 'left' }); await sleep(30); }
    chat.webContents.sendInputEvent({ type: 'mouseUp', x: g[0] + 120, y: g[1] + 90, button: 'left', clickCount: 1 });
    await sleep(300);
    const afterGrip = chat.getBounds();
    log.push({ step: '15b_grip', before: [before.width, before.height], after: [afterGrip.width, afterGrip.height], events: (await chat.webContents.executeJavaScript('window.__grip.slice(0,12)')) as string[], elAt: (await chat.webContents.executeJavaScript(`document.elementFromPoint(${g[0]},${g[1]})?.className`)) as string });
    const hidden = !chat.isVisible() && !chat.isDestroyed();
    windows.revealChat();
    await sleep(300);
    log.push({ step: '15_chat_controls', sizes: [b0.width, b1.width, b2.width], pinnedBefore, pinnedAfter, hiddenKeepsWindow: hidden, revealed: chat.isVisible(),
      historyKept: (await chat.webContents.executeJavaScript('document.querySelectorAll(".chat-msg").length')) as number });
    windows.openPanel('settings');
    await sleep(2500);
    const settingsWin = BrowserWindow.getAllWindows().find((w) => w !== pet && w !== chat);
    if (settingsWin) {
      await settingsWin.webContents.executeJavaScript('document.querySelectorAll("h2")[2]?.scrollIntoView(); "ok"');
      await sleep(300);
      fs.writeFileSync(path.join(dir, '14_agent_settings.png'), (await settingsWin.webContents.capturePage()).toPNG());
      const text = (await settingsWin.webContents.executeJavaScript('document.body.innerText')) as string;
      log.push({ step: '14_settings', hasPersonaSection: text.includes('她自己') && text.includes('自言自语'), hasAgentSection: text.includes('智能体'), memoryShown: text.includes('记忆'), tasksShown: text.includes('建一个叫') });
      // Theme: switching in settings recolours every window at once; "auto" follows the character.
      const accent = (w: BrowserWindow): Promise<string> => w.webContents.executeJavaScript('document.documentElement.dataset.theme + " " + getComputedStyle(document.documentElement).getPropertyValue("--orange").trim()') as Promise<string>;
      const themeBefore = [await accent(settingsWin), await accent(chat)];
      await settingsWin.webContents.executeJavaScript('window.petAPI.updateSettings({ theme: "blue" }).then(() => "ok")');
      await sleep(500);
      await settingsWin.webContents.executeJavaScript('window.scrollTo(0, 0); "ok"');
      await sleep(200);
      fs.writeFileSync(path.join(dir, '16_theme_blue_settings.png'), (await settingsWin.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(dir, '16_theme_blue_chat.png'), (await chat.webContents.capturePage()).toPNG());
      const themeBlue = [await accent(settingsWin), await accent(chat), await accent(pet)];
      await settingsWin.webContents.executeJavaScript('window.petAPI.updateSettings({ theme: "auto" }).then(() => "ok")');
      await sleep(400);
      // Tray / window icon follows the character (checked through the icon file each character names).
      const iconFiles = Object.fromEntries(Object.entries(CHARACTERS).map(([id, c]) => [id, fs.existsSync(path.join(app.getAppPath(), 'build', c.icon))]));
      await settingsWin.webContents.executeJavaScript('window.petAPI.updateSettings({ character: "deepseek" }).then(() => "ok")');
      await sleep(2500);
      const afterSwitch = { theme: await accent(chat), petCharacter: (await pet.webContents.executeJavaScript('window.__petEngine?.sprites.character')) as string };
      await settingsWin.webContents.executeJavaScript('window.petAPI.updateSettings({ character: "orange" }).then(() => "ok")');
      await sleep(2500);
      log.push({ step: '17_character_switch', iconFiles, afterSwitch, back: (await pet.webContents.executeJavaScript('window.__petEngine?.sprites.character')) as string });
      log.push({ step: '16_theme', themeBefore, themeBlue, backToAuto: await accent(chat), hasThemeRow: text.includes('界面颜色') });
    }
  }

  const seen = new Set<string>();
  for (let i = 0; i < 80; i++) { seen.add((await wc.executeJavaScript('document.body.dataset.petState')) as string); await sleep(250); }
  log.push({ step: '10_autonomous_20s', states: [...seen], bounds: pet.getBounds() });
  log.push({ step: 'errors', errors });
  fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify(log, null, 2));
  quit();
}

/** Development only: records frames of the walk / run / idle / drag animations for visual review. */
export async function captureFrames(windows: WindowManager, dir: string, quit: () => void, config?: ConfigStore): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const pet = windows.pet;
  if (!pet) { quit(); return; }
  const wc = pet.webContents;
  await sleep(3500);
  // PET_CHARACTER=deepseek records another character; the saved choice is put back afterwards.
  const before = config?.getSettings().character;
  const want = process.env.PET_CHARACTER;
  if (config && want && want !== before) {
    config.updateSettings({ character: want });
    wc.reload();
    await sleep(4000);
  }
  const run = (js: string): Promise<unknown> => wc.executeJavaScript(js);
  // Stop the autonomous behaviour from changing state while we record.
  await run(`(() => { const e = window.__petEngine; e.scheduler.update = () => {}; e.movement.update = () => ({ moved: false, landedWith: null, hitEdge: null }); return 'ok'; })()`);
  const shots: [string, string, number, number][] = [
    ['walkLeft', "e.movement.facing='left'; e.machine.force('walkLeft'); e.anim.setPose(e.sprites.pose('left'), true)", 16, 55],
    ['walkRight', "e.movement.facing='right'; e.machine.force('walkRight'); e.anim.setPose(e.sprites.pose('right'), true)", 16, 55],
    ['runRight', "e.movement.facing='right'; e.machine.force('run'); e.anim.setPose(e.sprites.pose('right'), true)", 12, 40],
    ['idle', "e.machine.force('idle'); e.anim.setPose(e.sprites.pose('idle'), true)", 8, 250],
    ['back', "e.machine.force('angry'); e.anim.setPose(e.sprites.pose('back'), true)", 2, 250],
    ['turnLeft', "e.movement.facing='left'; e.machine.force('turnLeft'); e.anim.setPose(e.sprites.pose('left'), true)", 2, 100],
    ['dragLow', "e.grabPoint={x:4,y:-24}; e.drag.begin(); e.machine.force('dragging'); e.anim.setPose(e.sprites.posesFor('dragging')[0], true)", 3, 120],
    ['dragEnd', "e.drag.end(); e.grabPoint=null; e.machine.force('idle'); e.anim.setPose(e.sprites.pose('idle'), true)", 1, 100],
    ['dragHigh', "e.grabPoint={x:0,y:-110}; e.drag.begin(); e.machine.force('dragging'); e.anim.setPose(e.sprites.posesFor('dragging')[0], true)", 2, 150],
    ['struggling', "e.machine.force('struggling'); e.anim.setPose(e.sprites.posesFor('struggling')[0], true)", 2, 150],
    ['dragEnd2', "e.drag.end(); e.grabPoint=null; e.machine.force('idle'); e.anim.setPose(e.sprites.pose('idle'), true)", 1, 100],
    ['petting', "e.machine.force('petting'); e.anim.setPose(e.sprites.posesFor('petting')[0], true)", 1, 200],
    ['shy', "e.machine.force('shy'); e.anim.setPose(e.sprites.posesFor('shy')[0], true)", 1, 200],
    ['eating', "e.machine.force('idle'); e.perform('eat', true)", 14, 220],    // same path as the right-click menu
    ['sleeping', "e.machine.force('sleeping'); e.anim.setPose(e.sprites.posesFor('sleeping')[0], true)", 1, 200],
    ['jump', "e.machine.force('jump'); e.anim.setPose(e.sprites.posesFor('jump')[0], true)", 2, 120],
    ['falling', "e.machine.force('falling'); e.anim.setPose(e.sprites.posesFor('falling')[0], true)", 1, 150],
    ['angry', "e.machine.force('angry'); e.anim.setPose(e.sprites.posesFor('angry')[0], true)", 1, 200],
    ['happy', "e.machine.force('happy'); e.anim.setPose(e.sprites.posesFor('happy')[0], true)", 6, 60],
  ];
  for (const [name, setup, n, gap] of shots) {
    await run(`(() => { const e = window.__petEngine; ${setup}; e.machine.limit = null; return 'ok'; })()`);
    await sleep(700);
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(dir, `${name}-${String(i).padStart(2, '0')}.png`), (await wc.capturePage()).toPNG());
      await sleep(gap);
    }
  }
  const info = await run(`(() => { const s = window.__petEngine.sprites; return { character: s.character, warnings: s.warnings, mirrored: s.mirroredSequences, blink: s.blinkClosed, poses: s.poseNames }; })()`);
  fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify(info, null, 2));
  if (config && before && config.getSettings().character !== before) { config.updateSettings({ character: before }); config.flush(); }
  quit();
}

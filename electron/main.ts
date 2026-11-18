import { app, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, protocol, Tray } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentRuntime } from './agent';
import { OpenAiCompatibleClient } from './agent/llm';
import { createElectronPlatform } from './agent/platform/electronPlatform';
import { registerAgentHandlers } from './agentIpc';
import { buildMonologuePrompt, buildPersona } from '../shared/persona';
import { buildUserBlock, inQuietHours } from '../shared/profile';
import { CHARACTERS, characterMeta, isBuiltinCharacter, type CharacterId } from '../shared/characters';
import { CustomCharacters, parseUserCharacterPath } from './customCharacters';
import { IPC } from '../shared/constants';
import { completeOnce, streamChat } from './aiClient';
import { remote } from './remote';
import { applyHotkey, clearHotkey, hotkeyOk } from './hotkey';
import { createSessionConversation } from './sessionConversation';
import { ConfigStore } from './configStore';
import { Monologue } from './monologue';
import { SelfModel } from './selfModel';
import { openClaudeDesktop, registerIpcHandlers, type PetLife } from './ipcHandlers';
import { WindowManager } from './windowManager';
import { registerUpdater, updateStatus } from './updater';

// Serve the built renderer from app://local/ instead of file:// so that fetch, canvas pixel reads
// (used for per-pixel hit testing) and a strict Content-Security-Policy all work.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let tray: Tray | null = null;
let rebuildTray: () => void = () => undefined;
let installUpdate: () => void = () => undefined;
let quitting = false;

function registerAppProtocol(characters: CustomCharacters): void {
  const root = path.join(app.getAppPath(), 'dist');
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    // Pictures of user-made characters: only PNGs directly inside one character folder.
    const custom = parseUserCharacterPath(url.pathname);
    if (custom) {
      const file = characters.fileFor(custom[0], custom[1]);
      if (!file) return new Response('Not found', { status: 404 });
      // Never cache: the user replaces these pictures and expects "重新载入形象" to show the new ones.
      return net.fetch(pathToFileURL(file).toString())
        .then((res) => new Response(res.body, { status: res.status, headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } }));
    }
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });   // no path traversal
    return net.fetch(pathToFileURL(file).toString());
  });
}

let characters: CustomCharacters;

/** The chosen character's face (falls back to the default one if the file is missing). */
function characterIcon(character: CharacterId): Electron.NativeImage {
  const file = isBuiltinCharacter(character)
    ? path.join(app.getAppPath(), 'build', CHARACTERS[character].icon)
    : characters.iconFor(character);
  const own = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  return own.isEmpty() ? nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.png')) : own;
}

/** Tray and window icons follow the character. (The .exe file's own icon is fixed when the app is built.) */
function applyCharacterIcon(windows: WindowManager, character: CharacterId): void {
  const icon = characterIcon(character);
  if (icon.isEmpty()) return;
  tray?.setImage(icon.resize({ width: 20, height: 20 }));
  windows.setIcon(icon);
}

function createTray(windows: WindowManager, quit: () => void, character: CharacterId): void {
  const icon = characterIcon(character);
  if (icon.isEmpty()) return;                                   // no tray rather than a crash
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('Chibi Desktop Pet');
  const rebuild = (): void => {
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: windows.isPetVisible() ? '隐藏桌宠' : '显示桌宠', click: () => { windows.setPetVisible(!windows.isPetVisible()); rebuild(); } },
      { label: '聊天', click: () => windows.openPanel('chat') },
      { label: '打开 Claude 桌面版', click: () => { void openClaudeDesktop(); } },
      { label: '设置…', click: () => windows.openPanel('settings') },
      ...(updateStatus().ready ? [{ label: '⬆ 安装新版本并重启', click: () => installUpdate() }] : []),
      { type: 'separator' },
      { label: '退出程序', click: quit },
    ]));
  };
  rebuildTray = rebuild;
  rebuild();
  tray.on('click', () => { windows.setPetVisible(true); rebuild(); });
  tray.on('right-click', rebuild);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => undefined);

  void app.whenReady().then(() => {
    characters = new CustomCharacters(path.join(app.getPath('userData'), 'characters'));
    registerAppProtocol(characters);
    const config = new ConfigStore();
    const windows = new WindowManager(config);
    const quit = (): void => { quitting = true; config.flush(); app.quit(); };

    // ---- her sense of self: persona + what happened to her, shared by chat, agent and self-talk ----
    const self = new SelfModel(path.join(app.getPath('userData'), 'self.json'));
    const persona = (): string => {
      const s = config.getSettings();
      return buildPersona({ name: s.petName, appearance: characterMeta(s.character, characters.list()).appearance, traits: s.personaTraits, selfState: self.summary(), user: buildUserBlock(s.profile) });
    };
    const activity = { streaming: 0 };
    const life: PetLife = { self, persona, activity, characters };

    const applySettings = registerIpcHandlers(config, windows, quit, life);

    // ---- agent: tools, permissions, plugins (everything runs here in the main process) ----
    const agentDir = path.join(app.getPath('userData'), 'agent');
    const agent = createAgentRuntime({
      baseDir: agentDir,
      platform: createElectronPlatform(),
      llm: new OpenAiCompatibleClient(() => ({ ...config.getAiEndpoint(), apiKey: config.getApiKey() })),
      settings: () => config.getAgentSettings(),
      vision: async (png, question, signal, options) => {
        const ep = config.getVisionEndpoint();
        if (!ep.model) throw new Error('还没有配置视觉模型（设置 → 智能体 → 视觉模型）。普通文本模型看不懂图片。');
        return remote.describeImage(ep, fs.readFileSync(png), question, signal, options);
      },
      pointAt: (target) => windows.pointAt(target),
      secrets: () => [config.getApiKey(), config.getVisionKey()],
      browser: () => ({ profileDir: path.join(agentDir, 'browser-profile'), headless: false, channels: ['msedge', 'chrome'] }),
      approvals: { get: () => config.getPluginApprovals(), set: (n, h) => config.setPluginApproval(n, h) },
      mcpServers: () => config.getMcpServers(),
      persona,
      builtinSkillsDir: path.join(app.getAppPath(), 'skills'),
    });
    registerAgentHandlers(config, windows, agent, applySettings, life);
    // Remote web chat, the shared desktop/web conversation and Computer Use (remote-chat/, packaged with the app).
    // The conversation lives in the session log (shared by the desktop chat, the web page and the model).
    const conversation = createSessionConversation({
      sessions: agent.sessions, recaps: agent.recaps,
      setChatHistory: (h) => config.setChatHistory(h),
      legacyHistoryFile: path.join(app.getPath('userData'), 'remote-chat', 'shared-history.json'),
      legacyDesktopHistory: () => config.getChatHistory(),
    });
    const remoteChat = remote.start({ config, agent, windows, life, app, streamChat, notifyChannel: IPC.petNotify, ipcMain, applySettings, conversation });

    // ---- scheduled / proactive tasks: run unattended and read-only through the shared conversation ----
    const runDueTasks = (): void => {
      const ready = config.getSettings().aiEnabled && !!config.getApiKey() && config.getAgentSettings().enabled;
      if (!ready || !remoteChat?.send || agent.controller.isRunning() || activity.streaming > 0) return;
      const task = agent.scheduler.due()[0];
      if (!task) return;
      // One at a time; if she just got busy, it stays due and runs on a later tick.
      if (remoteChat.send(`⏰ 定时任务「${task.name}」：${task.prompt}`, 'schedule', { readOnly: true, unattended: true, scheduleId: task.id })) agent.scheduler.markRun(task.id);
    };
    const scheduleTimer = setInterval(runDueTasks, 30_000);
    setTimeout(runDueTasks, 15_000);
    app.on('will-quit', () => clearInterval(scheduleTimer));
    agent.onScheduledDone((task, text, ok) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: `⏰ ${task.name}${ok ? '' : '（没有完成）'}`, body: text.slice(0, 160), icon: characterIcon(config.getSettings().character), silent: inQuietHours(config.getSettings().profile) });
      n.on('click', () => { windows.setPetVisible(true); windows.focusChat(); });
      n.show();
    });

    const monologue = new Monologue({
      level: () => config.getSettings().monologue,
      aiReady: () => config.getSettings().aiEnabled && !!config.getApiKey(),
      canSpeak: () => !inQuietHours(config.getSettings().profile) && windows.isPetVisible() && !windows.isDragging() && !agent.controller.isRunning() && activity.streaming === 0,
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      generate: (signal) => {
        const said = self.recentSaid();
        const moment = `${new Date().toLocaleString('zh-CN', { hour12: false })}${said.length ? `；最近说过：${said.slice(-4).join(' / ')}` : ''}`;
        return completeOnce({ ...config.getAiEndpoint(), apiKey: config.getApiKey(), system: buildMonologuePrompt(persona(), moment), signal });
      },
      deliver: (meta) => windows.sendToPet(IPC.petNotify, meta),
      remember: (line) => self.record('said', line),
    });
    const monologueTimer = setInterval(() => { void monologue.tick(); }, 60_000);
    app.on('will-quit', () => { clearInterval(monologueTimer); monologue.stop(); self.flush(); });
    void agent.plugins.reloadAll().then(() => agent.applyGroups());
    app.on('will-quit', () => { void agent.shutdown(); });
    app.on('second-instance', () => windows.setPetVisible(true));
    windows.applyUiMode();
    windows.createPetWindow();
    createTray(windows, quit, config.getSettings().character);
    installUpdate = registerUpdater((ch, p) => windows.broadcast(ch, p), quit, () => rebuildTray());
    // The chat window shows her face next to her replies (it follows the chosen character).
    ipcMain.handle('pet:avatar', (e) => {
      if (!windows.allWebContentsIds().includes(e.sender.id)) return '';
      const icon = characterIcon(config.getSettings().character);
      return icon.isEmpty() ? '' : icon.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
    });
    // The global hotkey brings her back and opens the chat ready for typing; re-registered on every settings change.
    const summon = (): void => { windows.setPetVisible(true); windows.focusChat(); };
    life.onSettings = () => { applyCharacterIcon(windows, config.getSettings().character); applyHotkey(config.getSettings().globalHotkey, summon); };
    app.on('will-quit', clearHotkey);
    ipcMain.handle('pet:hotkey-status', (e) => (windows.allWebContentsIds().includes(e.sender.id) ? { accelerator: config.getSettings().globalHotkey, ok: hotkeyOk() } : null));
    life.onSettings();
    app.setLoginItemSettings({ openAtLogin: config.getSettings().launchAtLogin });

    app.on('before-quit', () => { quitting = true; windows.allowClose(); config.flush(); });
    // Closing a panel must not end the app; only "退出程序" does.
    app.on('window-all-closed', () => { if (quitting) app.quit(); });

    // Development only: PET_POINT_DEMO="0.5,0.3,标签" shows the pointing (ring + pet) without a screenshot or a model.
    const demo = process.env.PET_POINT_DEMO?.split(',');
    if (demo && demo.length >= 2) {
      setTimeout(() => windows.pointAt({ nx: Number(demo[0]), ny: Number(demo[1]), label: demo[2] ?? '这里', note: demo[3] ?? '' }), 5000);
    }
    // Development only: `npm run smoke` drives the real app through a scripted scenario.
    if (process.env.PET_FRAMES_DIR) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./smoke') as typeof import('./smoke')).captureFrames(windows, process.env.PET_FRAMES_DIR, quit, config);
    } else if (process.env.PET_SMOKE_DIR) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./smoke') as typeof import('./smoke')).runSmokeScenario(windows, process.env.PET_SMOKE_DIR, quit, config);
    }
  });
}

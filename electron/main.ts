import { app, Menu, nativeImage, net, powerMonitor, protocol, Tray } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentRuntime } from './agent';
import { describeImage, OpenAiCompatibleClient } from './agent/llm';
import { createElectronPlatform } from './agent/platform/electronPlatform';
import { registerAgentHandlers } from './agentIpc';
import { buildMonologuePrompt, buildPersona } from '../shared/persona';
import { CHARACTERS, type CharacterId } from '../shared/characters';
import { IPC } from '../shared/constants';
import { completeOnce } from './aiClient';
import { ConfigStore } from './configStore';
import { Monologue } from './monologue';
import { SelfModel } from './selfModel';
import { openClaudeDesktop, registerIpcHandlers, type PetLife } from './ipcHandlers';
import { WindowManager } from './windowManager';

// Serve the built renderer from app://local/ instead of file:// so that fetch, canvas pixel reads
// (used for per-pixel hit testing) and a strict Content-Security-Policy all work.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let tray: Tray | null = null;
let quitting = false;

function registerAppProtocol(): void {
  const root = path.join(app.getAppPath(), 'dist');
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });   // no path traversal
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** The chosen character's face (falls back to the default one if the file is missing). */
function characterIcon(character: CharacterId): Electron.NativeImage {
  const own = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', CHARACTERS[character].icon));
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
      { type: 'separator' },
      { label: '退出程序', click: quit },
    ]));
  };
  rebuild();
  tray.on('click', () => { windows.setPetVisible(true); rebuild(); });
  tray.on('right-click', rebuild);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => undefined);

  void app.whenReady().then(() => {
    registerAppProtocol();
    const config = new ConfigStore();
    const windows = new WindowManager(config);
    const quit = (): void => { quitting = true; config.flush(); app.quit(); };

    // ---- her sense of self: persona + what happened to her, shared by chat, agent and self-talk ----
    const self = new SelfModel(path.join(app.getPath('userData'), 'self.json'));
    const persona = (): string => {
      const s = config.getSettings();
      return buildPersona({ name: s.petName, appearance: CHARACTERS[s.character].appearance, traits: s.personaTraits, selfState: self.summary() });
    };
    const activity = { streaming: 0 };
    const life: PetLife = { self, persona, activity };

    const applySettings = registerIpcHandlers(config, windows, quit, life);

    // ---- agent: tools, permissions, plugins (everything runs here in the main process) ----
    const agentDir = path.join(app.getPath('userData'), 'agent');
    const agent = createAgentRuntime({
      baseDir: agentDir,
      platform: createElectronPlatform(),
      llm: new OpenAiCompatibleClient(() => ({ ...config.getAiEndpoint(), apiKey: config.getApiKey() })),
      settings: () => config.getAgentSettings(),
      vision: async (png, question, signal) => {
        const ep = config.getVisionEndpoint();
        if (!ep.model) throw new Error('还没有配置视觉模型（设置 → 智能体 → 视觉模型）。普通文本模型看不懂图片。');
        return describeImage(ep, fs.readFileSync(png), question, signal);
      },
      secrets: () => [config.getApiKey(), config.getVisionKey()],
      browser: () => ({ profileDir: path.join(agentDir, 'browser-profile'), headless: false, channels: ['msedge', 'chrome'] }),
      approvals: { get: () => config.getPluginApprovals(), set: (n, h) => config.setPluginApproval(n, h) },
      mcpServers: () => config.getMcpServers(),
      persona,
    });
    registerAgentHandlers(config, windows, agent, applySettings, life);

    const monologue = new Monologue({
      level: () => config.getSettings().monologue,
      aiReady: () => config.getSettings().aiEnabled && !!config.getApiKey(),
      canSpeak: () => windows.isPetVisible() && !windows.isDragging() && !agent.controller.isRunning() && activity.streaming === 0,
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
    windows.createPetWindow();
    createTray(windows, quit, config.getSettings().character);
    life.onSettings = () => applyCharacterIcon(windows, config.getSettings().character);
    life.onSettings();
    app.setLoginItemSettings({ openAtLogin: config.getSettings().launchAtLogin });

    app.on('before-quit', () => { quitting = true; config.flush(); });
    // Closing a panel must not end the app; only "退出程序" does.
    app.on('window-all-closed', () => { if (quitting) app.quit(); });

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

import { app, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isEmotion, isPetAction } from '../shared/aiProtocol';
import { canEat } from '../shared/characters';
import { IPC } from '../shared/constants';
import { translate } from '../shared/i18n';
import type { AiStreamEvent, InitialData, MenuCommand, PetAction, Point } from '../shared/types';
import { streamChat } from './aiClient';
import { sanitizeHistory, sanitizeStats, type ConfigStore } from './configStore';
import type { CustomCharacters } from './customCharacters';
import type { SelfModel } from './selfModel';
import type { WindowManager } from './windowManager';

const SIZE_PRESETS: [string, number][] = [['迷你', 0.45], ['小', 0.6], ['中', 0.8], ['大', 1.0], ['特大', 1.3]];
const ACTION_LABELS: [string, PetAction][] = [
  ['打招呼', 'wave'], ['开心', 'happy'], ['跳一下', 'jump'], ['眨眼', 'wink'], ['害羞', 'shy'],
  ['张望', 'lookAround'], ['睡觉', 'sleep'],
];

/** Opens the Claude desktop app if it registered its link type, otherwise claude.ai in the browser. */
export async function openClaudeDesktop(): Promise<void> {
  const hasDesktopApp = app.getApplicationNameForProtocol('claude://') !== '';
  await shell.openExternal(hasDesktopApp ? 'claude://' : 'https://claude.ai');
}

export interface PetLife {
  self: SelfModel;
  persona(): string;
  /** Number of plain-chat replies being streamed right now. */
  activity: { streaming: number };
  /** Called after any settings change has been applied. */
  onSettings?: () => void;
  /** User-made characters (folder under userData). */
  characters?: CustomCharacters;
}

export function registerIpcHandlers(config: ConfigStore, windows: WindowManager, quit: () => void, life?: PetLife): () => void {
  const aborts = new Map<string, AbortController>();

  /** Ignore anything that does not come from one of our own windows. */
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => windows.allWebContentsIds().includes(e.sender.id);
  const on = (channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void): void => {
    ipcMain.on(channel, (e, ...args) => { if (trusted(e)) fn(e, ...args); });
  };

  const applySettings = (): void => {
    const s = config.getSettings();
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin });
    windows.applySettingsToWindows();
    windows.broadcast(IPC.settings, s);
    life?.onSettings?.();
  };

  ipcMain.handle(IPC.getInitialData, (e): InitialData | null => {
    if (!trusted(e)) return null;
    return {
      settings: config.getSettings(),
      stats: config.getStats(),
      placement: windows.getPlacement(),
      chatHistory: config.getChatHistory(),
      customCharacters: life?.characters?.list() ?? [],
    };
  });

  on(IPC.setIgnoreMouse, (e, ignore) => {
    if (windows.pet && e.sender.id === windows.pet.webContents.id) {
      windows.pet.setIgnoreMouseEvents(ignore === true, { forward: true });
    }
  });
  on(IPC.moveTo, (_e, feet) => {
    const p = feet as Point;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) windows.moveTo(p);
  });
  on(IPC.dragStart, () => { if (config.getSettings().allowDrag) { windows.startDrag(); life?.self.record('grabbed'); } });
  on(IPC.petEvent, (_e, kind) => { if (kind === 'petted' || kind === 'clicked' || kind === 'slept' || kind === 'woke') life?.self.record(kind); });
  on(IPC.dragEnd, () => windows.stopDrag());
  on(IPC.openChat, () => windows.openPanel('chat'));
  on(IPC.openSettings, () => windows.openPanel('settings'));
  on(IPC.closePanel, (e) => windows.closePanelOf(e.sender.id));
  ipcMain.handle(IPC.panelControl, (e, action) => (windows.allWebContentsIds().includes(e.sender.id) ? windows.chatControl(e.sender.id, String(action)) : null));
  on(IPC.openClaude, () => { void openClaudeDesktop(); });
  on(IPC.saveStats, (_e, stats) => config.setStats(sanitizeStats(stats, config.getStats())));
  on(IPC.saveChatHistory, (_e, history) => config.setChatHistory(sanitizeHistory(history)));

  ipcMain.handle(IPC.updateSettings, (e, patch) => {
    if (!trusted(e)) return config.getSettings();
    config.updateSettings(patch);
    applySettings();
    return config.getSettings();
  });
  // The user's avatar (我的资料): one small picture in the user-data folder.
  const avatarFile = (): string => path.join(app.getPath('userData'), 'user-avatar.img');
  ipcMain.handle(IPC.userAvatar, (e) => {
    if (!trusted(e) || !config.getSettings().profile.hasAvatar) return '';
    try { return fs.readFileSync(avatarFile(), 'utf8'); } catch { return ''; }
  });
  ipcMain.handle(IPC.userAvatarSet, (e, dataUrl) => {
    if (!trusted(e)) return { ok: false, error: '不可用', settings: config.getSettings() };
    if (dataUrl === null) {
      try { fs.rmSync(avatarFile(), { force: true }); } catch { /* ignore */ }
      config.setAvatarSaved(false); applySettings();
      return { ok: true, settings: config.getSettings() };
    }
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return { ok: false, error: '只支持 PNG、JPG 或 WebP 图片', settings: config.getSettings() };
    if (dataUrl.length > 700_000) return { ok: false, error: '图片太大了（压缩后仍超过 500 KB）', settings: config.getSettings() };
    fs.mkdirSync(path.dirname(avatarFile()), { recursive: true });
    fs.writeFileSync(avatarFile(), dataUrl, 'utf8');
    config.setAvatarSaved(true); applySettings();
    return { ok: true, settings: config.getSettings() };
  });
  ipcMain.handle(IPC.updateAiConfig, (e, patch) => {
    if (!trusted(e)) return config.getSettings();
    const s = config.updateAi((patch ?? {}) as { baseUrl?: unknown; model?: unknown; apiKey?: unknown });
    windows.broadcast(IPC.settings, s);
    return s;
  });

  on(IPC.showContextMenu, () => {
    const s = config.getSettings();
    const L = (zh: string): string => translate(s.language, zh);
    const send = (cmd: MenuCommand): void => windows.sendToPet(IPC.menuCommand, cmd);
    const toggle = (key: 'autoMove' | 'alwaysOnTop' | 'sound' | 'gravity', invert = false): MenuItemConstructorOptions => ({
      type: 'checkbox',
      checked: invert ? !s[key] : s[key],
      click: () => { config.updateSettings({ [key]: !s[key] }); applySettings(); },
    });
    const template: MenuItemConstructorOptions[] = [
      { label: L('聊天'), click: () => windows.openPanel('chat') },
      {
        label: L('切换动作'),
        submenu: [...ACTION_LABELS, ...(canEat(s.character, life?.characters?.list()) ? [['吃饭', 'eat'] as [string, PetAction]] : [])]
          .map(([label, action]) => ({ label: L(label), click: () => send({ type: 'action', action }) })),
      },
      {
        label: L('调整大小'),
        submenu: SIZE_PRESETS.map(([label, size]) => ({
          label: L(label), type: 'radio', checked: Math.abs(s.size - size) < 0.02,
          click: () => { config.updateSettings({ size }); applySettings(); },
        })),
      },
      { label: L('暂停自动移动'), ...toggle('autoMove', true) },
      { label: L('松手后掉到底部'), ...toggle('gravity') },
      { label: L('始终置顶'), ...toggle('alwaysOnTop') },
      { label: L('音效'), ...toggle('sound') },
      { type: 'separator' },
      { label: L('打开 Claude 桌面版'), click: () => { void openClaudeDesktop(); } },
      { label: L('设置…'), click: () => windows.openPanel('settings') },
      { label: L('隐藏桌宠'), click: () => windows.setPetVisible(false) },
      { type: 'separator' },
      { label: L('退出程序'), click: quit },
    ];
    Menu.buildFromTemplate(template).popup({ window: windows.pet ?? undefined });
  });

  // ---- AI chat: the request (and the API key) never leave the main process ----
  on(IPC.aiChat, (e, requestId, messages, stats) => {
    if (typeof requestId !== 'string') return;
    const reply = (event: AiStreamEvent): void => { if (!e.sender.isDestroyed()) e.sender.send(IPC.aiStream, event); };
    const settings = config.getSettings();
    if (!settings.aiEnabled) { reply({ type: 'error', requestId, message: 'AI 聊天未启用' }); return; }
    const controller = new AbortController();
    aborts.set(requestId, controller);
    const { baseUrl, model } = config.getAiEndpoint();
    if (life) { life.self.record('chatted'); life.activity.streaming += 1; }
    streamChat({
      persona: life?.persona(),
      baseUrl, model, apiKey: config.getApiKey(),
      messages: sanitizeHistory(messages),
      stats: sanitizeStats(stats, config.getStats()),
      signal: controller.signal,
      onDelta: (text) => reply({ type: 'delta', requestId, text }),
    })
      .then((result) => reply({ type: 'done', requestId, result }))
      .catch((err: unknown) => reply({ type: 'error', requestId, message: err instanceof Error ? err.message : '未知错误' }))
      .finally(() => { aborts.delete(requestId); if (life) life.activity.streaming = Math.max(0, life.activity.streaming - 1); });
  });
  on(IPC.aiAbort, (_e, requestId) => { if (typeof requestId === 'string') aborts.get(requestId)?.abort(); });

  // ---- user-made characters ----
  const characters = life?.characters;
  if (characters) {
    ipcMain.handle(IPC.charactersList, (e) => (trusted(e) ? characters.refresh() : []));
    on(IPC.charactersOpenFolder, () => { void shell.openPath(characters.ensureDir()); });
    on(IPC.charactersReloadPet, () => {
      characters.refresh();
      life?.onSettings?.();                                   // icon / theme of the (re)loaded character
      if (windows.pet && !windows.pet.isDestroyed()) windows.pet.webContents.reloadIgnoringCache();
    });
    ipcMain.handle(IPC.charactersCreate, (e, name, manifest, files) => {
      if (!trusted(e)) return { error: '不允许' };
      try {
        return { id: characters.create(name as string, manifest as Record<string, unknown>, files as { name: string; data: Uint8Array }[]).id };
      } catch (err) {
        return { error: err instanceof Error ? err.message : '创建失败' };
      }
    });
  }

  // Chat panel -> pet window: only whitelisted emotion/action values are forwarded.
  on(IPC.notifyPet, (_e, meta) => {
    const m = (meta ?? {}) as Record<string, unknown>;
    if (typeof m.talking === 'boolean') { windows.sendToPet(IPC.petNotify, { talking: m.talking }); return; }
    if (isEmotion(m.emotion) && isPetAction(m.action) && typeof m.reply === 'string') {
      windows.sendToPet(IPC.petNotify, { reply: m.reply.slice(0, 400), emotion: m.emotion, action: m.action });
    }
  });

  return applySettings;
}

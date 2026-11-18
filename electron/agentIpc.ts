import * as fs from 'node:fs';
import * as path from 'node:path';
import { dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import type { AgentEvent, AgentInfo, AgentManageResult, ConfirmDecision } from '../shared/agentTypes';
import { IPC } from '../shared/constants';
import { dropActions, dropHeader } from '../shared/fileDrop';
import { inspectDrop } from './fileDrop';
import type { AgentSettingsPatch, Settings } from '../shared/types';
import type { AgentRuntime } from './agent';
import { sanitizeHistory, sanitizeStats, type ConfigStore } from './configStore';
import type { PetLife } from './ipcHandlers';
import type { WindowManager } from './windowManager';

/** IPC for agent mode. The renderer can start/stop tasks and answer confirmations — nothing else. */
export function registerAgentHandlers(config: ConfigStore, windows: WindowManager, agent: AgentRuntime, applySettings: () => void, life?: PetLife): void {
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => windows.allWebContentsIds().includes(e.sender.id);
  const on = (channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void): void => {
    ipcMain.on(channel, (e, ...args) => { if (trusted(e)) fn(e, ...args); });
  };
  const handle = <T>(channel: string, fn: (...args: unknown[]) => T | Promise<T>, fallback: () => T): void => {
    ipcMain.handle(channel, (e, ...args) => (trusted(e) ? fn(...args) : fallback()));
  };

  on(IPC.agentRun, (e, requestId, messages, stats) => {
    if (typeof requestId !== 'string') return;
    const send = (event: AgentEvent): void => {
      if (event.type === 'confirm') windows.revealChat();
      if (!e.sender.isDestroyed()) e.sender.send(IPC.agentEvent, event);
    };
    const s = config.getSettings();
    if (!s.aiEnabled || !s.agent.enabled) { send({ type: 'error', requestId, message: 'AI 或智能体模式未启用' }); return; }
    if (agent.controller.isRunning()) { send({ type: 'error', requestId, message: '上一个任务还在进行，请先等它完成或点“停止”' }); return; }
    agent.refreshSecrets();
    agent.applyGroups();
    const history = sanitizeHistory(messages);
    const lastAsk = [...history].reverse().find((m) => m.role === 'user')?.content.replace(/\s+/g, ' ').slice(0, 24) ?? '';
    life?.self.record('chatted');
    void agent.controller.run(requestId, history, sanitizeStats(stats, config.getStats()), {
      emit: (event) => {
        // Only real tool work counts as "something I did" in her self memory; plain chat does not.
        if (event.type === 'done' && event.outcome === 'success') life?.self.record('taskDone', lastAsk);
        if (event.type === 'done' && event.outcome === 'failure') life?.self.record('taskFailed', lastAsk);
        send(event);
      },
      pet: (signal) => windows.sendToPet(IPC.petNotify, signal),
    });
  });
  on(IPC.agentAbort, (_e, requestId) => { if (typeof requestId === 'string') agent.controller.abort(requestId); });
  on(IPC.agentConfirm, (_e, confirmId, decision) => {
    if (typeof confirmId !== 'string') return;
    const d: ConfirmDecision = decision === 'allow' || decision === 'allow_task' ? decision : 'deny';
    agent.controller.resolveConfirm(confirmId, d);
  });

  const info = (): AgentInfo => agent.info();
  handle(IPC.agentInfo, info, info);
  handle<Settings>(IPC.agentUpdateSettings, (patch) => {
    const s = config.updateAgent((patch ?? {}) as AgentSettingsPatch);
    agent.applyGroups();
    agent.refreshSecrets();
    applySettings();
    return s;
  }, () => config.getSettings());
  handle<AgentInfo>(IPC.agentMemory, (op) => {
    const o = (op ?? {}) as { type?: string; id?: unknown; text?: unknown };
    if (o.type === 'delete' && typeof o.id === 'string') agent.memory.remove(o.id);
    if (o.type === 'update' && typeof o.id === 'string' && typeof o.text === 'string') agent.memory.update(o.id, o.text);
    return info();
  }, info);
  // The main window's 定时任务 / 技能 pages. These are the user's own clicks, so no confirmation card.
  handle<AgentManageResult>(IPC.agentManage, async (op) => {
    const o = (op ?? {}) as Record<string, unknown>;
    try {
      if (o.type === 'scheduleCreate') {
        agent.scheduler.add({ name: String(o.name ?? ''), prompt: String(o.prompt ?? ''), trigger: (o.trigger ?? {}) as Parameters<typeof agent.scheduler.add>[0]['trigger'] });
        return { ok: true, info: info() };
      }
      if (o.type === 'skillRead' && typeof o.name === 'string') {
        const sk = agent.skills.get(o.name);
        if (!sk) return { ok: false, error: '找不到这个技能' };
        return { ok: true, text: fs.readFileSync(path.join(sk.dir, 'SKILL.md'), 'utf8') };
      }
      if (o.type === 'skillSave') {
        agent.skills.save(String(o.name ?? ''), String(o.description ?? ''), String(o.body ?? ''));
        return { ok: true, info: info() };
      }
      if (o.type === 'skillDelete' && typeof o.name === 'string') {
        const sk = agent.skills.get(o.name);
        if (!sk || sk.source !== 'user') return { ok: false, error: '内置技能不能删除' };
        await shell.trashItem(sk.dir);          // to the recycle bin, so it can be restored
        return { ok: true, info: info() };
      }
      return { ok: false, error: '未知操作' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, () => ({ ok: false, error: '不可用' }));
  handle<string | null>(IPC.agentPickFolder, async () => {
    const r = await dialog.showOpenDialog({ title: '选择允许桌宠操作的文件夹', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  }, () => null);
  handle<AgentInfo>(IPC.agentPlugins, async (op) => {
    const o = (op ?? {}) as { type?: string; name?: unknown; approve?: unknown; servers?: unknown };
    if (o.type === 'approve' && typeof o.name === 'string') agent.plugins.approve(o.name, o.approve === true);
    // Hooks run the user's commands: only a click in the settings window turns the current hooks.json on.
    if (o.type === 'approveHooks') { agent.userHooks.approve(o.approve === true); return info(); }
    if (o.type === 'scheduleToggle' && typeof o.name === 'string') { agent.scheduler.setEnabled(o.name, o.approve === true); return info(); }
    if (o.type === 'scheduleDelete' && typeof o.name === 'string') { agent.scheduler.remove(o.name); return info(); }
    if (o.type === 'setMcp') config.setMcpServers(o.servers);
    if (o.type === 'approve' || o.type === 'setMcp' || o.type === 'reload') { await agent.plugins.reloadAll(); agent.applyGroups(); }
    return info();
  }, info);
  // ---- files dropped on her: a menu of what she can do; a choice becomes a normal chat request ----
  on(IPC.filesDropped, (e, paths) => {
    if (e.sender.id !== windows.pet?.webContents.id) return;
    const drop = inspectDrop(paths, agent.allowedRoots());
    if (!drop) return;
    const s = config.getSettings();
    const ready = s.aiEnabled && !!config.getApiKey() && s.agent.enabled;
    const busy = agent.controller.isRunning();
    const outside = drop.items.filter((i) => !i.allowed).length;
    const actions = dropActions(drop);
    const note = (label: string): MenuItemConstructorOptions => ({ label, enabled: false });
    const template: MenuItemConstructorOptions[] = [note(dropHeader(drop)), { type: 'separator' }];
    if (!ready) {
      template.push(note('要先在设置里打开 AI 和智能体模式'), { label: '打开设置…', click: () => windows.openPanel('settings') });
    } else if (actions.length === 0) {
      template.push(note('这些不在允许的文件夹里，她碰不到'), { label: '去设置里添加文件夹…', click: () => windows.openPanel('settings') });
    } else {
      if (outside) template.push(note(`有 ${outside} 个不在允许的文件夹里，先不管它们`));
      if (busy) template.push(note('她还在忙上一个任务，可以先告诉她要做什么'));
      for (const a of actions) {
        const startsNow = a.compose.prompt !== undefined;
        template.push({ label: a.label, enabled: !(busy && startsNow), click: () => windows.composeInChat(a.compose) });
      }
    }
    Menu.buildFromTemplate(template).popup({ window: windows.pet ?? undefined });
  });
  ipcMain.handle(IPC.agentCommand, (e, text) => {
    if (!trusted(e) || typeof text !== 'string' || text.length > 2000) return null;
    return agent.command(text);
  });
  ipcMain.handle(IPC.chatTakeCompose, (e) => (trusted(e) ? windows.takeCompose(e.sender.id) : null));

  on(IPC.agentOpenFolder, (_e, kind) => {
    if (kind === 'instructions') {
      // Her standing rules: create a short template the first time so there is something to open.
      if (!fs.existsSync(agent.instructionsFile)) {
        fs.writeFileSync(agent.instructionsFile, '# 给她的长期守则\n\n在这里写你希望她一直遵守的要求，每条一行。例如：\n\n- 整理文件时不要动“工作”文件夹\n- 回答尽量简短\n', 'utf8');
      }
      void shell.openPath(agent.instructionsFile);
      return;
    }
    if (kind === 'hooks') { agent.userHooks.ensureTemplate(); void shell.openPath(agent.userHooks.file); return; }
    if (kind === 'project') { const p = agent.sessions.project(); if (p && fs.existsSync(p)) void shell.openPath(p); return; }
    if (kind === 'skills') { fs.mkdirSync(agent.skills.userDir, { recursive: true }); void shell.openPath(agent.skills.userDir); return; }
    const dir = kind === 'plugins' ? agent.plugins.pluginDir : agent.logger.logDir;
    void shell.openPath(dir);
  });
}

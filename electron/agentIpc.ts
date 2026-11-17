import { dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { AgentEvent, AgentInfo, ConfirmDecision } from '../shared/agentTypes';
import { IPC } from '../shared/constants';
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
  handle<string | null>(IPC.agentPickFolder, async () => {
    const r = await dialog.showOpenDialog({ title: '选择允许桌宠操作的文件夹', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  }, () => null);
  handle<AgentInfo>(IPC.agentPlugins, async (op) => {
    const o = (op ?? {}) as { type?: string; name?: unknown; approve?: unknown; servers?: unknown };
    if (o.type === 'approve' && typeof o.name === 'string') agent.plugins.approve(o.name, o.approve === true);
    if (o.type === 'setMcp') config.setMcpServers(o.servers);
    if (o.type === 'approve' || o.type === 'setMcp' || o.type === 'reload') { await agent.plugins.reloadAll(); agent.applyGroups(); }
    return info();
  }, info);
  on(IPC.agentOpenFolder, (_e, kind) => {
    const dir = kind === 'plugins' ? agent.plugins.pluginDir : agent.logger.logDir;
    void shell.openPath(dir);
  });
}

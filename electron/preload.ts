import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PetAPI } from '../shared/types';

// NOTE: this file runs sandboxed, so it must not import anything except `electron` at runtime.
// Channel names are duplicated from shared/constants.ts on purpose (type-only imports are erased).
const C = {
  getInitialData: 'pet:get-initial-data', setIgnoreMouse: 'pet:set-ignore-mouse', moveTo: 'pet:move-to',
  dragStart: 'pet:drag-start', dragEnd: 'pet:drag-end', showContextMenu: 'pet:show-context-menu',
  openChat: 'pet:open-chat', openSettings: 'pet:open-settings', closePanel: 'pet:close-panel', panelControl: 'panel:control', panelResize: 'panel:resize',
  openClaude: 'pet:open-claude', saveStats: 'pet:save-stats', petEvent: 'pet:event', updateSettings: 'settings:update',
  updateAiConfig: 'settings:update-ai', saveChatHistory: 'chat:save-history', aiChat: 'ai:chat',
  aiAbort: 'ai:abort', notifyPet: 'pet:notify', placement: 'evt:placement', dragUpdate: 'evt:drag-update',
  settings: 'evt:settings', menuCommand: 'evt:menu-command', aiStream: 'evt:ai-stream',
  petNotify: 'evt:pet-notify', visibility: 'evt:visibility',
  agentRun: 'agent:run', agentAbort: 'agent:abort', agentConfirm: 'agent:confirm', agentInfo: 'agent:info',
  agentUpdateSettings: 'agent:update-settings', agentMemory: 'agent:memory', agentPickFolder: 'agent:pick-folder',
  agentPlugins: 'agent:plugins', agentOpenFolder: 'agent:open-folder', agentEvent: 'evt:agent',
  charactersList: 'characters:list', charactersOpenFolder: 'characters:open-folder', charactersReloadPet: 'characters:reload-pet',
  charactersCreate: 'characters:create',
} as const;

function listen<T>(channel: string) {
  return (cb: (payload: T) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  };
}

const api: PetAPI = {
  getInitialData: () => ipcRenderer.invoke(C.getInitialData),
  setIgnoreMouse: (ignore) => ipcRenderer.send(C.setIgnoreMouse, ignore),
  moveTo: (feet) => ipcRenderer.send(C.moveTo, feet),
  dragStart: () => ipcRenderer.send(C.dragStart),
  dragEnd: () => ipcRenderer.send(C.dragEnd),
  showContextMenu: () => ipcRenderer.send(C.showContextMenu),
  openChat: () => ipcRenderer.send(C.openChat),
  openSettings: () => ipcRenderer.send(C.openSettings),
  closePanel: () => ipcRenderer.send(C.closePanel),
  panelControl: (action) => ipcRenderer.invoke(C.panelControl, action),
  panelResize: (width, height) => ipcRenderer.send(C.panelResize, width, height),
  openClaude: () => ipcRenderer.send(C.openClaude),
  saveStats: (stats) => ipcRenderer.send(C.saveStats, stats),
  petEvent: (kind) => ipcRenderer.send(C.petEvent, kind),
  updateSettings: (patch) => ipcRenderer.invoke(C.updateSettings, patch),
  updateAiConfig: (patch) => ipcRenderer.invoke(C.updateAiConfig, patch),
  saveChatHistory: (history) => ipcRenderer.send(C.saveChatHistory, history),
  aiChat: (requestId, messages, stats) => ipcRenderer.send(C.aiChat, requestId, messages, stats),
  aiAbort: (requestId) => ipcRenderer.send(C.aiAbort, requestId),
  notifyPet: (meta) => ipcRenderer.send(C.notifyPet, meta),
  agentRun: (requestId, messages, stats) => ipcRenderer.send(C.agentRun, requestId, messages, stats),
  agentAbort: (requestId) => ipcRenderer.send(C.agentAbort, requestId),
  agentConfirm: (confirmId, decision) => ipcRenderer.send(C.agentConfirm, confirmId, decision),
  agentInfo: () => ipcRenderer.invoke(C.agentInfo),
  agentUpdateSettings: (patch) => ipcRenderer.invoke(C.agentUpdateSettings, patch),
  agentMemory: (op) => ipcRenderer.invoke(C.agentMemory, op),
  agentPickFolder: () => ipcRenderer.invoke(C.agentPickFolder),
  agentPlugins: (op) => ipcRenderer.invoke(C.agentPlugins, op),
  agentOpenFolder: (kind) => ipcRenderer.send(C.agentOpenFolder, kind),
  onAgentEvent: listen(C.agentEvent),
  listCharacters: () => ipcRenderer.invoke(C.charactersList),
  openCharactersFolder: () => ipcRenderer.send(C.charactersOpenFolder),
  reloadPet: () => ipcRenderer.send(C.charactersReloadPet),
  createCharacter: (name, manifest, files) => ipcRenderer.invoke(C.charactersCreate, name, manifest, files),
  onPlacement: listen(C.placement),
  onDragUpdate: listen(C.dragUpdate),
  onSettings: listen(C.settings),
  onMenuCommand: listen(C.menuCommand),
  onAiStream: listen(C.aiStream),
  onPetNotify: listen(C.petNotify),
  onVisibility: listen(C.visibility),
};

contextBridge.exposeInMainWorld('petAPI', api);

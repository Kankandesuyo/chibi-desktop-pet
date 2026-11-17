/** Geometry shared by main (window size) and renderer (where to draw). All values are DIP at size = 1. */
export const BASE_WINDOW_WIDTH = 420;
export const BASE_WINDOW_HEIGHT = 440;
/** Distance from the bottom edge of the window to the pet's feet. */
export const FOOT_MARGIN = 60;
/** Height of the standing character at size = 1. */
export const CHARACTER_HEIGHT = 220;
/** Half of the standing character's width, used to keep her on screen. */
export const CHARACTER_HALF_WIDTH = 82;

export const SIZE_MIN = 0.4;
export const SIZE_MAX = 1.4;

export const IPC = {
  getInitialData: 'pet:get-initial-data',
  setIgnoreMouse: 'pet:set-ignore-mouse',
  moveTo: 'pet:move-to',
  dragStart: 'pet:drag-start',
  dragEnd: 'pet:drag-end',
  showContextMenu: 'pet:show-context-menu',
  openChat: 'pet:open-chat',
  openSettings: 'pet:open-settings',
  closePanel: 'pet:close-panel',
  panelControl: 'panel:control',
  panelResize: 'panel:resize',
  openClaude: 'pet:open-claude',
  saveStats: 'pet:save-stats',
  petEvent: 'pet:event',
  updateSettings: 'settings:update',
  updateAiConfig: 'settings:update-ai',
  saveChatHistory: 'chat:save-history',
  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  notifyPet: 'pet:notify',
  agentRun: 'agent:run',
  agentAbort: 'agent:abort',
  agentConfirm: 'agent:confirm',
  agentInfo: 'agent:info',
  agentUpdateSettings: 'agent:update-settings',
  agentMemory: 'agent:memory',
  agentPickFolder: 'agent:pick-folder',
  agentPlugins: 'agent:plugins',
  agentOpenFolder: 'agent:open-folder',
  agentEvent: 'evt:agent',
  // user-made characters
  charactersList: 'characters:list',
  charactersOpenFolder: 'characters:open-folder',
  charactersReloadPet: 'characters:reload-pet',
  charactersCreate: 'characters:create',
  // main -> renderer
  placement: 'evt:placement',
  dragUpdate: 'evt:drag-update',
  settings: 'evt:settings',
  menuCommand: 'evt:menu-command',
  aiStream: 'evt:ai-stream',
  petNotify: 'evt:pet-notify',
  visibility: 'evt:visibility',
} as const;

export function windowSizeFor(size: number): { width: number; height: number } {
  return { width: Math.round(BASE_WINDOW_WIDTH * size), height: Math.round(BASE_WINDOW_HEIGHT * size) };
}

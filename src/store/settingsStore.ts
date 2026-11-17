import { create } from 'zustand';
import { TOOL_GROUPS, type ToolGroup } from '../../shared/agentTypes';
import type { AgentSettingsPatch, Settings } from '../../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  size: 0.6, opacity: 1, speed: 1, autoMoveFrequency: 0.5, autoMove: true, allowDrag: true, gravity: false, alwaysOnTop: true,
  sound: false, aiEnabled: false, launchAtLogin: false, character: 'orange', theme: 'auto', petName: '小橘', personaTraits: '', monologue: 'normal',
  ai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', hasApiKey: false },
  agent: {
    enabled: true, autoApproveMedium: false, allowedRoots: [], fullDiskAccess: true, toolProtocol: 'auto', maxSteps: 25,
    toolGroups: Object.fromEntries(TOOL_GROUPS.map((g) => [g, true])) as Record<ToolGroup, boolean>,
    vision: { baseUrl: '', model: '', hasApiKey: false },
  },
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** Replace with what the main process says (it is the source of truth and validates everything). */
  apply(settings: Settings): void;
  update(patch: Partial<Omit<Settings, 'ai' | 'agent'>>): Promise<void>;
  updateAgent(patch: AgentSettingsPatch): Promise<void>;
  updateAi(patch: { baseUrl?: string; model?: string; apiKey?: string }): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  apply: (settings) => set({ settings, loaded: true }),
  update: async (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));          // optimistic, so sliders feel instant
    set({ settings: await window.petAPI.updateSettings(patch) });
  },
  updateAi: async (patch) => set({ settings: await window.petAPI.updateAiConfig(patch) }),
  updateAgent: async (patch) => set({ settings: await window.petAPI.agentUpdateSettings(patch) }),
}));

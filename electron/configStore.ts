import { DEFAULT_CHARACTER, isCharacterId, isThemeChoice } from '../shared/characters';
import { cleanPetName, cleanTraits, DEFAULT_PET_NAME, isMonologueLevel } from '../shared/persona';
import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_HOTKEY, HOTKEY_CHOICES, SIZE_MAX, SIZE_MIN } from '../shared/constants';
import { sanitizeRules } from './agent/permissionRules';
import { DEFAULT_PROFILE, sanitizeProfile } from '../shared/profile';
import { DEFAULT_CONTEXT_WINDOW, TOOL_GROUPS, type AgentSettings, type McpServerConfig, type ToolGroup } from '../shared/agentTypes';
import { EMOTIONS, type AgentSettingsPatch, type ChatMessage, type Emotion, type PetStats, type Point, type Settings } from '../shared/types';

type CoreSettings = Omit<Settings, 'ai' | 'agent'>;

type StoredAgentSettings = Omit<AgentSettings, 'vision'> & { vision: { baseUrl: string; model: string } };

interface StoredAgent {
  settings: StoredAgentSettings;
  visionKeyEncrypted: string;
  visionKeyPlain: string;
  /** Approved local plugins: name -> hash of their files. */
  approvals: Record<string, string>;
  mcpServers: McpServerConfig[];
}

interface StoredConfig {
  settings: CoreSettings;
  ai: { baseUrl: string; model: string; apiKeyEncrypted: string; apiKeyPlain: string };
  stats: PetStats;
  feet: Point | null;
  chatHistory: ChatMessage[];
  agent: StoredAgent;
  /** Main window placement (remembered between launches). */
  mainWindow: MainWindowState | null;
}

export interface MainWindowState { x: number; y: number; width: number; height: number; maximized: boolean }

const DEFAULT_AGENT: StoredAgent = {
  settings: {
    enabled: true, autoApproveMedium: false, readOnly: false, permissionRules: { allow: [], deny: [] }, allowedRoots: [], fullDiskAccess: true,
    toolGroups: Object.fromEntries(TOOL_GROUPS.map((g) => [g, true])) as Record<ToolGroup, boolean>,
    toolProtocol: 'auto', maxSteps: 25, contextWindow: DEFAULT_CONTEXT_WINDOW, projectLanguage: 'zh', vision: { baseUrl: '', model: '' },
  },
  visionKeyEncrypted: '', visionKeyPlain: '', approvals: {}, mcpServers: [],
};

const DEFAULTS: StoredConfig = {
  settings: {
    size: 0.6, opacity: 1, speed: 1, autoMoveFrequency: 0.5, autoMove: true, allowDrag: true, gravity: false,
    alwaysOnTop: true, sound: false, aiEnabled: false, launchAtLogin: false, globalHotkey: DEFAULT_HOTKEY,
    petName: DEFAULT_PET_NAME, personaTraits: '', monologue: 'normal', character: DEFAULT_CHARACTER, theme: 'auto',
    uiMode: 'system', profile: DEFAULT_PROFILE,
  },
  ai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKeyEncrypted: '', apiKeyPlain: '' },
  stats: { mood: 'neutral', affection: 30, energy: 80, interactionCount: 0 },
  feet: null,
  chatHistory: [],
  agent: DEFAULT_AGENT,
  mainWindow: null,
};

function sanitizeWindow(input: unknown): MainWindowState | null {
  const w = (input ?? null) as Record<string, unknown> | null;
  if (!w || ![w.x, w.y, w.width, w.height].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return { x: Math.round(w.x as number), y: Math.round(w.y as number), width: Math.round(num(w.width, 600, 10000, 1000)), height: Math.round(num(w.height, 400, 10000, 700)), maximized: bool(w.maximized, false) };
}

const MAX_HISTORY = 40;

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function str(v: unknown, fallback: string, maxLen = 500): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : fallback;
}

export function sanitizeSettings(input: unknown, base: CoreSettings): CoreSettings {
  const s = (input ?? {}) as Record<string, unknown>;
  return {
    size: num(s.size, SIZE_MIN, SIZE_MAX, base.size),
    opacity: num(s.opacity, 0.3, 1, base.opacity),
    speed: num(s.speed, 0.5, 2, base.speed),
    autoMoveFrequency: num(s.autoMoveFrequency, 0, 1, base.autoMoveFrequency),
    autoMove: bool(s.autoMove, base.autoMove),
    allowDrag: bool(s.allowDrag, base.allowDrag),
    gravity: bool(s.gravity, base.gravity),
    alwaysOnTop: bool(s.alwaysOnTop, base.alwaysOnTop),
    sound: bool(s.sound, base.sound),
    aiEnabled: bool(s.aiEnabled, base.aiEnabled),
    launchAtLogin: bool(s.launchAtLogin, base.launchAtLogin),
    globalHotkey: typeof s.globalHotkey === 'string' && (HOTKEY_CHOICES as readonly string[]).includes(s.globalHotkey) ? s.globalHotkey : base.globalHotkey,
    character: isCharacterId(s.character) ? s.character : base.character,
    theme: isThemeChoice(s.theme) ? s.theme : base.theme,
    petName: cleanPetName(s.petName, base.petName),
    personaTraits: cleanTraits(s.personaTraits, base.personaTraits),
    monologue: isMonologueLevel(s.monologue) ? s.monologue : base.monologue,
    uiMode: s.uiMode === 'light' || s.uiMode === 'dark' || s.uiMode === 'system' ? s.uiMode : base.uiMode,
    profile: sanitizeProfile(s.profile, base.profile ?? DEFAULT_PROFILE),
  };
}

export function sanitizeAgentSettings(input: unknown, base: StoredAgentSettings): StoredAgentSettings {
  const s = (input ?? {}) as Record<string, unknown>;
  const groups = (s.toolGroups ?? {}) as Record<string, unknown>;
  const vision = (s.vision ?? {}) as Record<string, unknown>;
  const roots = Array.isArray(s.allowedRoots) ? s.allowedRoots : base.allowedRoots;
  return {
    enabled: bool(s.enabled, base.enabled),
    autoApproveMedium: bool(s.autoApproveMedium, base.autoApproveMedium),
    readOnly: bool(s.readOnly, base.readOnly),
    permissionRules: s.permissionRules === undefined ? base.permissionRules : sanitizeRules(s.permissionRules),
    fullDiskAccess: bool(s.fullDiskAccess, base.fullDiskAccess),
    allowedRoots: [...new Set(roots.filter((r): r is string => typeof r === 'string' && path.isAbsolute(r)).map((r) => r.slice(0, 500)))].slice(0, 30),
    toolGroups: Object.fromEntries(TOOL_GROUPS.map((g) => [g, bool(groups[g], base.toolGroups[g])])) as Record<ToolGroup, boolean>,
    toolProtocol: s.toolProtocol === 'native' || s.toolProtocol === 'json' || s.toolProtocol === 'auto' ? s.toolProtocol : base.toolProtocol,
    maxSteps: Math.round(num(s.maxSteps, 3, 60, base.maxSteps)),
    contextWindow: Math.round(num(s.contextWindow, 8000, 2000000, base.contextWindow ?? DEFAULT_CONTEXT_WINDOW)),
    projectLanguage: s.projectLanguage === 'zh' || s.projectLanguage === 'en' || s.projectLanguage === 'ja' ? s.projectLanguage : (base.projectLanguage ?? 'zh'),
    vision: { baseUrl: str(vision.baseUrl, base.vision.baseUrl).trim(), model: str(vision.model, base.vision.model, 100).trim() },
  };
}

export function sanitizeMcpServers(input: unknown): McpServerConfig[] {
  if (!Array.isArray(input)) return [];
  const out: McpServerConfig[] = [];
  for (const raw of input) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const name = str(r.name, '', 30).trim().replace(/[^\w-]/g, '');
    const command = str(r.command, '', 300).trim();
    if (!name || !command || out.some((x) => x.name === name)) continue;
    out.push({
      name, command,
      args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, 500)).slice(0, 30) : [],
      enabled: bool(r.enabled, true),
      risk: r.risk === 'high' ? 'high' : 'medium',
    });
  }
  return out.slice(0, 20);
}

export function sanitizeStats(input: unknown, base: PetStats): PetStats {
  const s = (input ?? {}) as Record<string, unknown>;
  const mood = (EMOTIONS as readonly string[]).includes(s.mood as string) ? (s.mood as Emotion) : base.mood;
  return {
    mood,
    affection: num(s.affection, 0, 100, base.affection),
    energy: num(s.energy, 0, 100, base.energy),
    interactionCount: Math.floor(num(s.interactionCount, 0, 1e9, base.interactionCount)),
  };
}

export function sanitizeHistory(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  const out: ChatMessage[] = [];
  for (const m of input) {
    const r = m as Record<string, unknown>;
    if ((r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string') {
      out.push({ role: r.role, content: r.content.slice(0, 4000) });
    }
  }
  return out.slice(-MAX_HISTORY);
}

/** Small JSON config in the user-data folder. Corrupt or missing files fall back to defaults. */
export class ConfigStore {
  private data: StoredConfig = structuredClone(DEFAULTS);
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredConfig>;
      const ai = (raw.ai ?? {}) as Record<string, unknown>;
      const feet = raw.feet as Point | null | undefined;
      this.data = {
        settings: sanitizeSettings(raw.settings, DEFAULTS.settings),
        ai: {
          baseUrl: str(ai.baseUrl, DEFAULTS.ai.baseUrl),
          model: str(ai.model, DEFAULTS.ai.model, 100),
          apiKeyEncrypted: str(ai.apiKeyEncrypted, '', 4000),
          apiKeyPlain: str(ai.apiKeyPlain, '', 400),
        },
        stats: sanitizeStats(raw.stats, DEFAULTS.stats),
        feet: feet && Number.isFinite(feet.x) && Number.isFinite(feet.y) ? { x: feet.x, y: feet.y } : null,
        chatHistory: sanitizeHistory(raw.chatHistory),
        agent: this.loadAgent(raw.agent),
        mainWindow: sanitizeWindow(raw.mainWindow),
      };
    } catch {
      this.data = structuredClone(DEFAULTS);
    }
  }

  private loadAgent(raw: unknown): StoredAgent {
    const a = (raw ?? {}) as Record<string, unknown>;
    const approvals: Record<string, string> = {};
    for (const [k, v] of Object.entries((a.approvals ?? {}) as Record<string, unknown>)) if (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) approvals[k] = v;
    return {
      settings: sanitizeAgentSettings(a.settings, DEFAULT_AGENT.settings),
      visionKeyEncrypted: str(a.visionKeyEncrypted, '', 4000),
      visionKeyPlain: str(a.visionKeyPlain, '', 400),
      approvals,
      mcpServers: sanitizeMcpServers(a.mcpServers),
    };
  }

  private scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  /** Write via a temp file so a crash mid-write cannot leave a half-written config. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[config] save failed', err);
    }
  }

  getSettings(): Settings {
    return {
      ...this.data.settings,
      profile: { ...this.data.settings.profile },
      ai: { baseUrl: this.data.ai.baseUrl, model: this.data.ai.model, hasApiKey: this.getApiKey() !== '' },
      agent: this.getAgentSettings(),
    };
  }

  getAgentSettings(): AgentSettings {
    const s = this.data.agent.settings;
    return { ...s, allowedRoots: [...s.allowedRoots], toolGroups: { ...s.toolGroups }, vision: { ...s.vision, hasApiKey: this.getVisionKey() !== '' } };
  }

  updateAgent(patch: AgentSettingsPatch): Settings {
    const { vision, ...rest } = (patch ?? {}) as AgentSettingsPatch;
    const merged = { ...this.data.agent.settings, ...rest, toolGroups: { ...this.data.agent.settings.toolGroups, ...(rest.toolGroups ?? {}) }, vision: { ...this.data.agent.settings.vision, ...(vision ?? {}) } };
    this.data.agent.settings = sanitizeAgentSettings(merged, this.data.agent.settings);
    if (vision && typeof vision.apiKey === 'string') {
      const key = vision.apiKey.trim().slice(0, 400);
      if (key && safeStorage.isEncryptionAvailable()) { this.data.agent.visionKeyEncrypted = safeStorage.encryptString(key).toString('base64'); this.data.agent.visionKeyPlain = ''; }
      else { this.data.agent.visionKeyEncrypted = ''; this.data.agent.visionKeyPlain = key; }
    }
    this.scheduleSave();
    return this.getSettings();
  }

  getVisionKey(): string {
    const { visionKeyEncrypted, visionKeyPlain } = this.data.agent;
    if (visionKeyEncrypted) { try { return safeStorage.decryptString(Buffer.from(visionKeyEncrypted, 'base64')); } catch { return ''; } }
    return visionKeyPlain;
  }

  /** Vision endpoint: falls back to the chat endpoint's URL and key when left empty. */
  getVisionEndpoint(): { baseUrl: string; model: string; apiKey: string } {
    const v = this.data.agent.settings.vision;
    return { baseUrl: v.baseUrl || this.data.ai.baseUrl, model: v.model, apiKey: this.getVisionKey() || this.getApiKey() };
  }

  getPluginApprovals(): Record<string, string> { return { ...this.data.agent.approvals }; }
  setPluginApproval(name: string, hash: string | null): void {
    if (hash) this.data.agent.approvals[name] = hash; else delete this.data.agent.approvals[name];
    this.scheduleSave();
  }
  getMcpServers(): McpServerConfig[] { return this.data.agent.mcpServers.map((s) => ({ ...s, args: [...s.args] })); }
  setMcpServers(servers: unknown): void { this.data.agent.mcpServers = sanitizeMcpServers(servers); this.scheduleSave(); }

  updateSettings(patch: unknown): Settings {
    const p = { ...((patch ?? {}) as Record<string, unknown>) };
    // Profile patches merge field by field; whether an avatar exists is only set by setAvatarSaved().
    if (p.profile && typeof p.profile === 'object') p.profile = { ...this.data.settings.profile, ...(p.profile as object), hasAvatar: this.data.settings.profile.hasAvatar };
    this.data.settings = sanitizeSettings({ ...this.data.settings, ...p }, this.data.settings);
    this.scheduleSave();
    return this.getSettings();
  }

  updateAi(patch: { baseUrl?: unknown; model?: unknown; apiKey?: unknown }): Settings {
    if (typeof patch.baseUrl === 'string') this.data.ai.baseUrl = patch.baseUrl.trim().slice(0, 500);
    if (typeof patch.model === 'string') this.data.ai.model = patch.model.trim().slice(0, 100);
    if (typeof patch.apiKey === 'string') {
      const key = patch.apiKey.trim().slice(0, 400);
      if (key !== '' && safeStorage.isEncryptionAvailable()) {
        this.data.ai.apiKeyEncrypted = safeStorage.encryptString(key).toString('base64');
        this.data.ai.apiKeyPlain = '';
      } else {
        this.data.ai.apiKeyEncrypted = '';
        this.data.ai.apiKeyPlain = key;   // only when the OS offers no encryption
      }
    }
    this.scheduleSave();
    return this.getSettings();
  }

  /** Main-process only. */
  getApiKey(): string {
    const { apiKeyEncrypted, apiKeyPlain } = this.data.ai;
    if (apiKeyEncrypted) {
      try { return safeStorage.decryptString(Buffer.from(apiKeyEncrypted, 'base64')); } catch { return ''; }
    }
    return apiKeyPlain;
  }

  getAiEndpoint(): { baseUrl: string; model: string } {
    return { baseUrl: this.data.ai.baseUrl, model: this.data.ai.model };
  }

  setAvatarSaved(saved: boolean): Settings {
    this.data.settings.profile = { ...this.data.settings.profile, hasAvatar: saved };
    this.scheduleSave();
    return this.getSettings();
  }

  getMainWindow(): MainWindowState | null { return this.data.mainWindow ? { ...this.data.mainWindow } : null; }
  setMainWindow(state: MainWindowState): void { this.data.mainWindow = sanitizeWindow(state); this.scheduleSave(); }

  getStats(): PetStats { return { ...this.data.stats }; }
  setStats(stats: unknown): void { this.data.stats = sanitizeStats(stats, this.data.stats); this.scheduleSave(); }

  getFeet(): Point | null { return this.data.feet ? { ...this.data.feet } : null; }
  setFeet(feet: Point): void { this.data.feet = { x: Math.round(feet.x), y: Math.round(feet.y) }; this.scheduleSave(); }

  getChatHistory(): ChatMessage[] { return [...this.data.chatHistory]; }
  setChatHistory(history: unknown): void { this.data.chatHistory = sanitizeHistory(history); this.scheduleSave(); }
}

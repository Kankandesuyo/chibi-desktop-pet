import type { CharacterId, CustomCharacterInfo, ThemeChoice } from './characters';
import type { MonologueLevel } from './persona';
/** Types and constants shared by the Electron main process and the renderer. */
import type { AgentEvent, AgentInfo, AgentPetSignal, AgentSettings, AgentStepView, ConfirmDecision, ConfirmRequest, McpServerConfig, PlanStepView } from './agentTypes';

export const PET_STATES = [
  'idle', 'blink', 'lookAround', 'walkLeft', 'walkRight', 'run', 'turnLeft', 'turnRight', 'jump',
  'dragStart', 'dragging', 'struggling', 'falling', 'landing', 'petting', 'happy', 'shy', 'angry',
  'sleeping', 'waking', 'talking',
  /** A little scene of her own (e.g. eating), only for characters whose art has a sequence for it. */
  'eating',
] as const;
export type PetState = (typeof PET_STATES)[number];

export const EMOTIONS = ['neutral', 'happy', 'shy', 'angry', 'sleepy', 'surprised'] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** Actions the AI (or the right-click menu) may ask the pet to perform. Anything else is rejected. */
export const PET_ACTIONS = ['none', 'wave', 'jump', 'happy', 'shy', 'angry', 'sleep', 'wink', 'lookAround', 'eat'] as const;
export type PetAction = (typeof PET_ACTIONS)[number];

export interface PetStats {
  mood: Emotion;
  /** 0–100 */
  affection: number;
  /** 0–100 */
  energy: number;
  interactionCount: number;
}

export interface AiPublicConfig {
  baseUrl: string;
  model: string;
  /** The key itself never leaves the main process; the renderer only learns whether one is stored. */
  hasApiKey: boolean;
}

export interface Settings {
  /** Pet scale, 0.4–1.4 (1 = 220 px tall). */
  size: number;
  /** 0.3–1 */
  opacity: number;
  /** Animation / movement speed multiplier, 0.5–2. */
  speed: number;
  /** How often she does something on her own, 0–1. */
  autoMoveFrequency: number;
  autoMove: boolean;
  allowDrag: boolean;
  /** true: she drops to the bottom of the screen when released. false: she stays where you put her. */
  gravity: boolean;
  alwaysOnTop: boolean;
  sound: boolean;
  aiEnabled: boolean;
  launchAtLogin: boolean;
  /** Colours of the windows: follow the character, or a fixed theme. */
  theme: ThemeChoice;
  /** Which character is shown. */
  character: CharacterId;
  /** Her name (persona). */
  petName: string;
  /** Extra personality notes written by the user. */
  personaTraits: string;
  /** How often she talks to herself. */
  monologue: MonologueLevel;
  ai: AiPublicConfig;
  agent: AgentSettings;
}

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** Where the pet is: screen position of her feet (DIP) and the work area of the display she is on. */
export interface PetPlacement { feet: Point; workArea: Rect }

export interface DragUpdate { feet: Point; vx: number; vy: number }

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface AiReplyMeta { reply: string; emotion: Emotion; action: PetAction }

export type AiStreamEvent =
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'done'; requestId: string; result: AiReplyMeta }
  | { type: 'error'; requestId: string; message: string };

export type PanelAction = 'state' | 'toggle-pin' | 'bigger' | 'smaller' | 'hide';
export interface PanelState { pinned: boolean; sizeIndex: number; sizeCount: number }

export type PetNotice = AiReplyMeta | { talking: boolean } | AgentPetSignal;

export type AgentSettingsPatch = Partial<Omit<AgentSettings, 'vision'>> & { vision?: { baseUrl?: string; model?: string; apiKey?: string } };

export type MenuCommand =
  | { type: 'action'; action: PetAction }
  | { type: 'openChat' };

export interface InitialData {
  settings: Settings;
  stats: PetStats;
  placement: PetPlacement;
  chatHistory: ChatMessage[];
  /** User-made characters found in the characters folder. */
  customCharacters: CustomCharacterInfo[];
}

/** The only surface the renderer can reach — exposed by preload.ts as `window.petAPI`. */
export interface PetAPI {
  getInitialData(): Promise<InitialData>;
  // window behaviour
  setIgnoreMouse(ignore: boolean): void;
  moveTo(feet: Point): void;
  dragStart(): void;
  dragEnd(): void;
  showContextMenu(): void;
  openChat(): void;
  openSettings(): void;
  closePanel(): void;
  openClaude(): void;
  // persistence
  saveStats(stats: PetStats): void;
  /** Something happened to her (petted, slept...). Feeds her self memory. */
  petEvent(kind: 'petted' | 'clicked' | 'slept' | 'woke'): void;
  updateSettings(patch: Partial<Omit<Settings, 'ai' | 'agent'>>): Promise<Settings>;
  updateAiConfig(patch: { baseUrl?: string; model?: string; apiKey?: string }): Promise<Settings>;
  saveChatHistory(history: ChatMessage[]): void;
  // AI
  aiChat(requestId: string, messages: ChatMessage[], stats: PetStats): void;
  aiAbort(requestId: string): void;
  notifyPet(meta: AiReplyMeta | { talking: boolean }): void;
  /** Chat window controls: pin on top, bigger/smaller, hide (keeps running tasks). */
  panelControl(action: PanelAction): Promise<PanelState>;
  /** Drag-resize from the corner grip (transparent windows cannot be resized by their border on Windows). */
  panelResize(width: number, height: number): void;
  // Agent (tool-using) mode
  agentRun(requestId: string, messages: ChatMessage[], stats: PetStats): void;
  agentAbort(requestId: string): void;
  agentConfirm(confirmId: string, decision: ConfirmDecision): void;
  agentInfo(): Promise<AgentInfo>;
  agentUpdateSettings(patch: AgentSettingsPatch): Promise<Settings>;
  agentMemory(op: { type: 'update'; id: string; text: string } | { type: 'delete'; id: string }): Promise<AgentInfo>;
  agentPickFolder(): Promise<string | null>;
  agentPlugins(op: { type: 'approve'; name: string; approve: boolean } | { type: 'reload' } | { type: 'setMcp'; servers: McpServerConfig[] }): Promise<AgentInfo>;
  agentOpenFolder(kind: 'logs' | 'plugins'): void;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  // user-made characters
  /** Re-reads the characters folder. */
  listCharacters(): Promise<CustomCharacterInfo[]>;
  openCharactersFolder(): void;
  /** Reloads the pet window so edited pictures show up. */
  reloadPet(): void;
  createCharacter(name: string, manifest: Record<string, unknown>, files: { name: string; data: Uint8Array }[]): Promise<{ id?: CharacterId; error?: string }>;
  // events from main
  onPlacement(cb: (p: PetPlacement) => void): () => void;
  onDragUpdate(cb: (u: DragUpdate) => void): () => void;
  onSettings(cb: (s: Settings) => void): () => void;
  onMenuCommand(cb: (c: MenuCommand) => void): () => void;
  onAiStream(cb: (e: AiStreamEvent) => void): () => void;
  onPetNotify(cb: (meta: PetNotice) => void): () => void;
  onVisibility(cb: (visible: boolean) => void): () => void;
  // Shared conversation (desktop chat + remote web page). Only present when the remote-chat add-on
  // (remote-chat/server.cjs, wired in by remote-chat/install.py) is installed; otherwise chat is local.
  sharedState?(): Promise<SharedChatSnapshot>;
  sharedSend?(text: string): Promise<{ error?: string }>;
  sharedAbort?(): Promise<unknown>;
  sharedClear?(): Promise<{ error?: string }>;
  onSharedChat?(cb: (s: SharedChatSnapshot) => void): () => void;
}

/** One authoritative conversation, owned by remote-chat/server.cjs and pushed to every chat view. */
export interface SharedChatSnapshot {
  error?: string;
  version: number;
  messages: (ChatMessage & { steps?: AgentStepView[]; failed?: boolean })[];
  active: {
    id: string;
    mode: 'chat' | 'agent' | 'vision';
    text: string;
    steps: AgentStepView[];
    plan: PlanStepView[];
    interim: string;
    confirm: ConfirmRequest | null;
  } | null;
}

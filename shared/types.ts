import type { UserProfile } from './profile';
import type { CharacterId, CustomCharacterInfo, ThemeChoice } from './characters';
import type { MonologueLevel } from './persona';
import type { ChatCompose } from './fileDrop';
import type { SessionStatsView, SessionSummary, TrajectoryEvent } from './harness';
/** Types and constants shared by the Electron main process and the renderer. */
import type { AgentCommandResult, AgentEvent, AgentInfo, AgentManageOp, AgentManageResult, AgentPetSignal, AgentSettings, AgentStepView, ConfirmDecision, ConfirmRequest, McpServerConfig, PlanStepView } from './agentTypes';

export const PET_STATES = [
  'idle', 'blink', 'lookAround', 'walkLeft', 'walkRight', 'run', 'turnLeft', 'turnRight', 'jump',
  'dragStart', 'dragging', 'struggling', 'falling', 'landing', 'petting', 'happy', 'shy', 'angry',
  'sleeping', 'waking', 'talking',
  /** A little scene of her own (e.g. eating), only for characters whose art has a sequence for it. */
  'eating',
  /** Showing the user a spot on screen (after walking over to it). */
  'pointing',
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

export type UiMode = 'system' | 'light' | 'dark';

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
  /** System-wide shortcut that brings her back and opens the chat ('' = off). */
  globalHotkey: string;
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
  /** Light / dark look of the main window ('system' follows Windows). */
  uiMode: UiMode;
  /** The local user's profile (我的资料). */
  profile: UserProfile;
  ai: AiPublicConfig;
  agent: AgentSettings;
}

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** Where the pet is: screen position of her feet (DIP) and the work area of the display she is on. */
export interface PetPlacement { feet: Point; workArea: Rect }

export interface DragUpdate { feet: Point; vx: number; vy: number }

export interface PointRequest { point: Point; label: string; note: string }
export interface HighlightRequest { x: number; y: number; label: string; id: number }

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface AiReplyMeta { reply: string; emotion: Emotion; action: PetAction }

export type AiStreamEvent =
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'done'; requestId: string; result: AiReplyMeta }
  | { type: 'error'; requestId: string; message: string };

export type PanelAction = 'state' | 'toggle-pin' | 'toggle-fullscreen' | 'hide';
/** A new build staged as resources/app.asar.new, installed from inside the app. */
export interface UpdateStatus { ready: boolean; stagedAt?: number; error?: string }
export interface PanelState { pinned: boolean; fullscreen: boolean; maximized: boolean }

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
  /** Main window state changed (maximized / full screen). */
  onPanelState(cb: (s: PanelState) => void): () => void;
  // Agent (tool-using) mode
  agentRun(requestId: string, messages: ChatMessage[], stats: PetStats): void;
  agentAbort(requestId: string): void;
  agentConfirm(confirmId: string, decision: ConfirmDecision): void;
  agentInfo(): Promise<AgentInfo>;
  agentUpdateSettings(patch: AgentSettingsPatch): Promise<Settings>;
  agentMemory(op: { type: 'update'; id: string; text: string } | { type: 'delete'; id: string }): Promise<AgentInfo>;
  agentPickFolder(): Promise<string | null>;
  agentPlugins(op: { type: 'approve'; name: string; approve: boolean } | { type: 'approveHooks'; approve: boolean } | { type: 'scheduleToggle'; name: string; approve: boolean } | { type: 'scheduleDelete'; name: string } | { type: 'reload' } | { type: 'setMcp'; servers: McpServerConfig[] }): Promise<AgentInfo>;
  /** 定时任务 / 技能 pages of the main window. */
  agentManage(op: AgentManageOp): Promise<AgentManageResult>;
  /** The user's avatar as a data URL ('' = none). */
  userAvatar(): Promise<string>;
  /** Saves (data URL of a PNG/JPEG/WebP picture) or removes (null) the user's avatar. */
  userAvatarSet(dataUrl: string | null): Promise<{ ok: boolean; error?: string; settings: Settings }>;
  /** The main process asks the main window to show a page (e.g. "settings"). */
  onNavigate(cb: (page: string) => void): () => void;
  /** Whether a staged update is waiting, and installing it (the app restarts). */
  updateStatus(): Promise<UpdateStatus>;
  updateApply(): Promise<{ ok: boolean; error?: string }>;
  onUpdate(cb: (s: UpdateStatus) => void): () => void;
  agentOpenFolder(kind: 'logs' | 'plugins' | 'skills' | 'instructions' | 'hooks'): void;
  /** A chat slash command; null when the text is not one (send it as a message instead). */
  agentCommand(text: string): Promise<AgentCommandResult | null>;
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
  /** The agent wants her to show the user a spot on screen (screen DIP). */
  onPetPoint(cb: (p: PointRequest) => void): () => void;
  /** Highlight overlay only: where to draw the ring (window-relative DIP). */
  onHighlight(cb: (h: HighlightRequest) => void): () => void;
  // Files dropped on her
  /** Real path of a dropped file ('' if it has none, e.g. dragged from a browser). */
  pathForFile(file: File): string;
  /** Pet window: these were dropped on her; main shows the "what should I do" menu. */
  filesDropped(paths: string[]): void;
  /** Pet window: cursor inside the window (window DIP), or null when it left. Polled by main. */
  onCursor(cb: (p: { x: number; y: number } | null) => void): () => void;
  /** Chat window: the pending request about dropped files, if any (taking it clears it). */
  takeChatCompose(): Promise<ChatCompose | null>;
  onChatCompose(cb: () => void): () => void;
  /** Chat window: the global hotkey was pressed (put the cursor in the input). */
  onChatFocus(cb: () => void): () => void;
  // Harness: sessions (the left column of the chat), the raw event log of the current session, her face.
  sessionsList(): Promise<{ current: string; sessions: SessionSummary[] } | { error: string }>;
  sessionOpen(id: string): Promise<{ ok: true; id: string } | { error: string }>;
  sessionNew(): Promise<{ ok: true; id: string } | { error: string }>;
  trajectory(): Promise<{ id: string; events: TrajectoryEvent[] } | { error: string }>;
  /** Her current face as a small PNG data URL ('' if unavailable). */
  petAvatar(): Promise<string>;
  /** Is the global hotkey registered? (ok=false: another program already uses those keys) */
  hotkeyStatus(): Promise<{ accelerator: string; ok: boolean } | null>;
  // Shared conversation (desktop chat + remote web page), run by remote-chat/server.cjs inside the app.
  // Optional only for very old builds; the chat falls back to a local conversation without it.
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
  /** The current session and its run stats (harness builds). */
  session?: { id: string; stats: SessionStatsView } | null;
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

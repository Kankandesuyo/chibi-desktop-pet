import { create } from 'zustand';
import type { PetState, PetStats } from '../../shared/types';

interface PetUiState {
  ready: boolean;
  state: PetState;
  stats: PetStats;
  bubble: { id: number; text: string } | null;
  warnings: string[];
  setReady(warnings: string[]): void;
  setState(state: PetState): void;
  setStats(stats: PetStats): void;
  say(text: string, ms?: number): void;
}

let bubbleId = 0;
let bubbleTimer: number | null = null;

/** What the React layer needs to know about the pet. The engine writes here only on real changes
 *  (never per frame), so React does not re-render while she animates. */
export const usePetStore = create<PetUiState>((set) => ({
  ready: false,
  state: 'idle',
  stats: { mood: 'neutral', affection: 30, energy: 80, interactionCount: 0 },
  bubble: null,
  warnings: [],
  setReady: (warnings) => set({ ready: true, warnings }),
  setState: (state) => set({ state }),
  setStats: (stats) => set({ stats }),
  say: (text, ms = 2200) => {
    const id = ++bubbleId;
    if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
    set({ bubble: { id, text } });
    bubbleTimer = window.setTimeout(() => set((s) => (s.bubble?.id === id ? { bubble: null } : s)), ms);
  },
}));

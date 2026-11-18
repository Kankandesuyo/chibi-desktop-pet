/// <reference types="vite/client" />
import type { PetAPI } from '../shared/types';

declare global {
  interface Window { petAPI: PetAPI }
  /** Stamped in by vite.config.mts at build time. */
  const __BUILD__: { version: string; commit: string; dirty: boolean; time: string };
}
export {};

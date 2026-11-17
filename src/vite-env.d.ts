/// <reference types="vite/client" />
import type { PetAPI } from '../shared/types';

declare global {
  interface Window { petAPI: PetAPI }
}
export {};

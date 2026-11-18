import { useSettingsStore } from './store/settingsStore';
import { translate, type Lang, type Vars } from '../shared/i18n';

export type T = (zh: string, vars?: Vars) => string;

/** In components: re-renders when the language changes. */
export function useT(): T {
  const lang = useSettingsStore((s) => s.settings.language);
  return (zh, vars) => translate(lang, zh, vars);
}

/** Outside components (stores, engine): the language right now. */
export function tNow(zh: string, vars?: Vars): string {
  return translate(useSettingsStore.getState().settings.language, zh, vars);
}

export function langNow(): Lang { return useSettingsStore.getState().settings.language; }

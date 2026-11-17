/**
 * Selectable characters. Built-in art lives in assets/characters; this part is shared with the main process.
 * Users can add their own: one folder per character under <userData>/characters, selected as "custom:<folder>".
 */
export const CHARACTER_IDS = ['orange', 'deepseek'] as const;
export type BuiltinCharacterId = typeof CHARACTER_IDS[number];
export const CUSTOM_PREFIX = 'custom:';
export type CustomCharacterId = `custom:${string}`;
export type CharacterId = BuiltinCharacterId | CustomCharacterId;
export const DEFAULT_CHARACTER: BuiltinCharacterId = 'orange';

/** A user-made character found in the characters folder (sent to the renderer). */
export interface CustomCharacterInfo {
  id: CustomCharacterId;
  folder: string;
  label: string;
  appearance: string;
  note: string;
  theme: ThemeId;
  /** The character's manifest.json (same format as the built-in ones). */
  manifest: Record<string, unknown>;
  /** PNG files directly inside the folder. */
  files: string[];
  hasIcon: boolean;
  /** Why the folder cannot be used (bad manifest, no pictures...). */
  error?: string;
}

/** Folder names usable as part of a character id and a URL: no path parts, no Windows-reserved characters. */
export function isSafeFolderName(name: unknown): name is string {
  return typeof name === 'string' && name.length >= 1 && name.length <= 40 && name.trim() === name
    && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/^\.+$/.test(name) && !name.endsWith('.');
}

export function isBuiltinCharacter(v: unknown): v is BuiltinCharacterId {
  return typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v);
}

export function isCustomCharacterId(v: unknown): v is CustomCharacterId {
  return typeof v === 'string' && v.startsWith(CUSTOM_PREFIX) && isSafeFolderName(v.slice(CUSTOM_PREFIX.length));
}

export function customCharacterId(folder: string): CustomCharacterId { return `${CUSTOM_PREFIX}${folder}`; }

/** Colour themes of the chat / settings windows and the speech bubble. 'auto' follows the character. */
export const THEME_IDS = ['orange', 'blue'] as const;
export type ThemeId = typeof THEME_IDS[number];
export type ThemeChoice = 'auto' | ThemeId;
export const THEME_LABELS: Record<ThemeChoice, string> = { auto: '跟随角色', orange: '暖橙', blue: '海蓝' };
/** Window background per theme (used before the page has painted). */
export const THEME_PAPER: Record<ThemeId, string> = { orange: '#fff8f0', blue: '#f3f6ff' };

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === 'auto' || (typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v));
}

export function resolveTheme(choice: ThemeChoice, character: CharacterId, custom: readonly CustomCharacterInfo[] = []): ThemeId {
  return choice === 'auto' ? characterMeta(character, custom).theme : choice;
}

export interface CharacterMeta { label: string; appearance: string; note: string; theme: ThemeId; custom: boolean; missing: boolean }

/** Name, look and theme of any character. A custom one that is gone falls back to the default character. */
export function characterMeta(id: CharacterId, custom: readonly CustomCharacterInfo[] = []): CharacterMeta {
  if (isBuiltinCharacter(id)) return { ...CHARACTERS[id], custom: false, missing: false };
  const c = custom.find((x) => x.id === id && !x.error);
  if (c) return { label: c.label, appearance: c.appearance || CHARACTERS.orange.appearance, note: c.note, theme: c.theme, custom: true, missing: false };
  return { ...CHARACTERS[DEFAULT_CHARACTER], note: `找不到自定义角色「${id.slice(CUSTOM_PREFIX.length)}」，暂时显示默认形象。`, custom: true, missing: true };
}

export const CHARACTERS: Record<BuiltinCharacterId, { label: string; appearance: string; note: string; theme: ThemeId; icon: string }> = {
  orange: {
    label: '橙发女孩',
    appearance: 'Q 版女孩，橙色长发，戴橙色花朵发饰、黑色蝴蝶结和金色流苏，穿白橙黑相间的裙子和白色系带小靴子',
    note: '',
    theme: 'orange',
    icon: 'icon.png',
  },
  deepseek: {
    label: 'DeepSeek / 鲸鱼女仆',
    appearance: 'Q 版鲸鱼女仆，蓝紫到浅蓝渐变的长发和一根弯弯的呆毛，蓝眼睛，戴白色蕾丝女仆头饰、鲸鳍形装饰和蓝色蝴蝶结，穿深蓝与白色的女仆裙和白色鲸鱼图案围裙，有一条鲸鱼尾巴，白袜子和深蓝色小皮鞋',
    note: '向右走是左走的镜像占位；眨眼已关闭（没有和站立图完全对得上的闭眼图）。',
    theme: 'blue',
    icon: 'icon-deepseek.png',
  },
};

export function isCharacterId(v: unknown): v is CharacterId {
  return isBuiltinCharacter(v) || isCustomCharacterId(v);
}

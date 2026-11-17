/** Selectable characters. The art lives in assets/characters; this part is shared with the main process. */
export const CHARACTER_IDS = ['orange', 'deepseek'] as const;
export type CharacterId = typeof CHARACTER_IDS[number];
export const DEFAULT_CHARACTER: CharacterId = 'orange';

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

export function resolveTheme(choice: ThemeChoice, character: CharacterId): ThemeId {
  return choice === 'auto' ? (CHARACTERS[character] ?? CHARACTERS.orange).theme : choice;
}

export const CHARACTERS: Record<CharacterId, { label: string; appearance: string; note: string; theme: ThemeId; icon: string }> = {
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
  return typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v);
}

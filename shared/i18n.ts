import { DICT } from './i18nDict';

/**
 * The app's language (设置 → 外观 → 语言). The Chinese text is the key: `translate('en', '新会话')` looks it up in
 * DICT and falls back to the Chinese when a string has no translation yet, so nothing ever shows up blank.
 * Placeholders are written {name} in every language.
 */
export type Lang = 'zh' | 'en' | 'ja';

export const LANGS: readonly { id: Lang; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
];

export const isLang = (v: unknown): v is Lang => v === 'zh' || v === 'en' || v === 'ja';

export type Vars = Record<string, string | number>;

export function translate(lang: Lang, zh: string, vars?: Vars): string {
  const row = lang === 'zh' ? undefined : DICT[zh];
  let s = row ? (lang === 'en' ? row[0] : row[1]) : zh;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** What she is told about the language to speak (persona, agent, self-talk). */
export const SPEAK: Record<Lang, string> = {
  zh: '用中文和用户说话（回答、气泡、汇报都用中文；代码里的标识符照常用英文）。',
  en: 'Always speak to the user in English: replies, speech bubbles, reports, code comments and commit messages. Keep this even though these instructions are written in Chinese. Only switch if the user explicitly asks for another language.',
  ja: 'ユーザーとは常に日本語で話すこと：返答、吹き出し、報告、コードのコメントやコミットメッセージも日本語。この指示文が中国語で書かれていても日本語を使う。ユーザーが明示的に別の言語を求めた場合のみ切り替える。',
};

/** Locale for dates and numbers. */
export const LOCALE: Record<Lang, string> = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' };

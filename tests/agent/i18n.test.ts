/**
 * The app language: every Chinese text in the window / pet code has an English and a Japanese version,
 * with the same {placeholders}.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DICT } from '../../shared/i18nDict';
import { translate } from '../../shared/i18n';

const ROOT = path.resolve(__dirname, '../..');
const HAN = /[一-鿿]/;
/** Chinese literals that are not shown to the user (or are names), so they need no translation. */
const NOT_UI = new Set<string>([
  '小橘',                      // her default name
  '已取消',                    // compared with the agent's own error text, never shown
]);
const SKIP_FILES = /SpriteManager\.ts$/;   // asset warnings for whoever makes characters (console)

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(tsx?)$/.test(e.name) && !SKIP_FILES.test(p)) out.push(p);
  }
  return out;
}

/**
 * Text the code holds in Chinese: string literals, template literals with Chinese outside ${…} and bare JSX
 * text. A small scanner (the project's TypeScript 7 has no JS parser API): it skips comments and regex literals.
 */
const BACKSLASH = String.fromCharCode(92);

function chineseLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  let prev = '';                                    // last significant code character (regex vs division)
  const readQuoted = (q: string): string => {
    let j = i + 1; let raw = q;
    while (j < src.length && src[j] !== q && src[j] !== '\n') { if (src[j] === BACKSLASH) { raw += src[j] + src[j + 1]; j += 2; continue; } raw += src[j]; j++; }
    i = j + 1;
    return raw + q;
  };
  const readTemplate = (): void => {
    // i is at the opening backtick; collect literal text, recurse into ${…} as code.
    let j = i + 1; let text = ''; let hasExpr = false;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === BACKSLASH) { text += src[j + 1]; j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        hasExpr = true; let depth = 1; j += 2;
        while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
        text += '${}'; continue;
      }
      text += src[j]; j++;
    }
    i = j + 1;
    if (HAN.test(text.replace(/\$\{\}/g, ''))) out.push(hasExpr ? `TEMPLATE: ${text}` : text);
  };
  while (i < src.length) {
    const c = src[i] as string; const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prev)) {                 // regex literal
      let j = i + 1; let cls = false;
      while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === BACKSLASH) j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      i = j + 1; prev = ')'; continue;
    }
    if (c === "'" || c === '"') {
      const raw = readQuoted(c);
      // eslint-disable-next-line no-new-func
      if (HAN.test(raw)) { try { out.push(new Function(`return ${raw}`)() as string); } catch { out.push(raw); } }
      prev = ')'; continue;
    }
    if (c === '`') { readTemplate(); prev = ')'; continue; }
    if (HAN.test(c)) {                                                   // bare text in code = JSX text
      let a = i; while (a > 0 && !/[>}\n]/.test(src[a - 1] as string)) a--;
      let b = i; while (b < src.length && !/[<{\n]/.test(src[b] as string)) b++;
      out.push(`JSX TEXT: ${src.slice(a, b).trim()}`);
      i = b; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

describe('app language', () => {
  it('every Chinese text in the UI code has English and Japanese', () => {
    const missing: string[] = [];
    for (const f of files(path.join(ROOT, 'src'))) {
      for (const s of chineseLiterals(fs.readFileSync(f, 'utf8'))) {
        if (!DICT[s] && !NOT_UI.has(s)) missing.push(`${path.relative(ROOT, f)}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the scanner sees literals, templates and JSX text but not comments or regexes', () => {
    const sample = [
      "const a = '中文一';",
      'const b = `模板 ${x} 二`;',
      '// 注释不算',
      'const r = /正则|不算/;',
      'const el = <b>界面三</b>;',
      "const ok = t('设置');",
    ].join(String.fromCharCode(10));
    expect(chineseLiterals(sample)).toEqual(['中文一', 'TEMPLATE: 模板 ${} 二', 'JSX TEXT: 界面三', '设置']);
  });

  it('scans a meaningful amount of the real UI', () => {
    let n = 0;
    for (const f of files(path.join(ROOT, 'src'))) n += chineseLiterals(fs.readFileSync(f, 'utf8')).length;
    expect(n).toBeGreaterThan(300);
  });

  it('translations keep the placeholders and are not left in Chinese', () => {
    for (const [zh, [en, ja]] of Object.entries(DICT)) {
      expect(placeholders(en), `${zh} → ${en}`).toEqual(placeholders(zh));
      expect(placeholders(ja), `${zh} → ${ja}`).toEqual(placeholders(zh));
      expect(HAN.test(en.replace(/\{\w+\}/g, '')), `English still has Chinese: ${en}`).toBe(false);
      expect(en.trim(), zh).not.toBe('');
      expect(ja.trim(), zh).not.toBe('');
    }
  });

  it('translate falls back to Chinese and fills placeholders', () => {
    expect(translate('en', '设置')).toBe('Settings');
    expect(translate('ja', '设置')).toBe('設定');
    expect(translate('zh', '设置')).toBe('设置');
    expect(translate('en', '还没有翻译的一句话')).toBe('还没有翻译的一句话');
    expect(translate('en', '会话 {id}', { id: 'abc' })).toBe('Session abc');
  });
});

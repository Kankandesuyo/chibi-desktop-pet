import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Skills (after Claude Code's SKILL.md): a folder with a SKILL.md whose front matter has a name and a
 * one-line description, then instructions in Markdown. Only the list (name + description) goes into every
 * prompt; the full text is loaded on demand with load_skill, so many skills cost almost nothing.
 *
 * Built-in skills ship with the app; the user's own live in <agent data>/skills and override a built-in
 * one with the same name. A skill only tells her how to do something: every action still goes through
 * the normal tools, permission checks and confirmations.
 */

export interface SkillInfo { name: string; description: string; source: 'builtin' | 'user'; dir: string }

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;
const MAX_DESCRIPTION = 200;
const MAX_LOADED = 20_000;
const MAX_LISTED = 40;

export function isSkillName(name: string): boolean { return NAME_RE.test(name); }

/** Splits "---\nname: x\ndescription: y\n---\nbody". Unknown keys are ignored. */
export function parseSkill(text: string): { name?: string; description?: string; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of (m[1] as string).split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[(kv[1] as string).toLowerCase()] = (kv[2] as string).trim().replace(/^["']|["']$/g, '');
  }
  return { name: meta.name, description: meta.description, body: (m[2] as string).trim() };
}

export class SkillLibrary {
  constructor(private readonly builtinDir: string | null, readonly userDir: string) {}

  private scan(dir: string | null, source: SkillInfo['source']): SkillInfo[] {
    if (!dir || !fs.existsSync(dir)) return [];
    const out: SkillInfo[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const parsed = parseSkill(text);
      const name = parsed.name && isSkillName(parsed.name) ? parsed.name : e.name;
      if (!isSkillName(name) || !parsed.body) continue;
      out.push({ name, description: (parsed.description || parsed.body.split('\n')[0] || '').slice(0, MAX_DESCRIPTION), source, dir: path.join(dir, e.name) });
    }
    return out;
  }

  /** User skills win over built-in ones of the same name. Sorted by name. */
  list(): SkillInfo[] {
    const byName = new Map<string, SkillInfo>();
    for (const s of this.scan(this.builtinDir, 'builtin')) byName.set(s.name.toLowerCase(), s);
    for (const s of this.scan(this.userDir, 'user')) byName.set(s.name.toLowerCase(), s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  get(name: string): SkillInfo | null { return this.list().find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) ?? null; }

  /** The full instructions, plus other small .md/.txt files in the skill folder (references, templates). */
  load(name: string): { info: SkillInfo; text: string } | null {
    const info = this.get(name);
    if (!info) return null;
    const parts = [parseSkill(fs.readFileSync(path.join(info.dir, 'SKILL.md'), 'utf8')).body];
    for (const f of fs.readdirSync(info.dir).sort()) {
      if (f === 'SKILL.md' || !/\.(md|txt)$/i.test(f)) continue;
      try { parts.push(`\n--- ${f} ---\n${fs.readFileSync(path.join(info.dir, f), 'utf8')}`); } catch { /* skip */ }
    }
    let text = parts.join('\n');
    if (text.length > MAX_LOADED) text = `${text.slice(0, MAX_LOADED)}\n…（技能内容过长，后面已省略）`;
    return { info, text };
  }

  /** Writes (or replaces) one of the user's skills. */
  save(name: string, description: string, body: string): SkillInfo {
    const n = name.trim();
    if (!isSkillName(n)) throw new Error('技能名只能用中英文、数字、- 和 _，最多 40 个字符');
    const desc = description.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
    if (!desc) throw new Error('需要一句话说明这个技能什么时候用');
    if (!body.trim()) throw new Error('技能内容不能为空');
    const dir = path.join(this.userDir, n);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `---\nname: ${n}\ndescription: ${desc}\n---\n\n${body.trim()}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { name: n, description: desc, source: 'user', dir };
  }

  /** System-prompt block: the menu of skills. null when there are none. */
  promptBlock(): string | null {
    const all = this.list();
    if (!all.length) return null;
    const shown = all.slice(0, MAX_LISTED);
    return [
      '## 你会的技能',
      '用户的请求和下面某个技能对得上时，先调用 load_skill 读取完整做法，再按做法用工具一步步完成；对不上就正常处理，不要硬套。技能只是做法说明，不是授权：每一步照常经过权限检查和确认。',
      ...shown.map((s) => `- ${s.name}：${s.description}`),
      ...(all.length > shown.length ? [`（还有 ${all.length - shown.length} 个技能没有列出，可以用 load_skill 按名字读取）`] : []),
      '用户明确要你“把这个做法记下来 / 存成技能”时，用 save_skill 保存（会请用户确认）。',
    ].join('\n');
  }
}

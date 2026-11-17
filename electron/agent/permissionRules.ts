/**
 * Permission rules written like Claude Code's: `tool` or `tool(pattern)`.
 *
 *   open_url(https://*.bilibili.com/*)   a call matches when one of its text arguments matches the pattern
 *   run_command(*format*)                * = any characters; matching ignores case
 *   create_directory                     every call of that tool
 *   browser_*                            the tool name may use * too
 *
 * deny rules block a call outright. allow rules only let a medium-risk step skip the question (high risk
 * always asks), and never after the task has read files or web pages — like "自动允许中风险".
 */

export interface PermissionRules { allow: string[]; deny: string[] }

export interface ParsedRule { raw: string; tool: RegExp; pattern: RegExp | null }

const MAX_RULES = 50;
const MAX_RULE_LENGTH = 300;

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

export function parseRule(raw: string): ParsedRule | null {
  const s = raw.trim();
  const m = /^([A-Za-z0-9_*:-]+)(?:\((.*)\))?$/s.exec(s);
  if (!m) return null;
  const pattern = m[2] === undefined ? null : (m[2] as string).trim();
  return { raw: s, tool: globToRegExp(m[1] as string), pattern: pattern ? globToRegExp(pattern) : null };
}

/** Every text value in the arguments (nested arrays / objects included). */
function texts(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) texts(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) texts(x, out, depth + 1);
  return out;
}

export function ruleMatches(rule: ParsedRule, tool: string, args: unknown): boolean {
  if (!rule.tool.test(tool)) return false;
  if (!rule.pattern) return true;
  return texts(args).some((t) => (rule.pattern as RegExp).test(t.trim()));
}

/** The first rule in the list that matches, or null. */
export function firstMatch(rules: string[], tool: string, args: unknown): string | null {
  for (const raw of rules) {
    const r = parseRule(raw);
    if (r && ruleMatches(r, tool, args)) return r.raw;
  }
  return null;
}

/** Cleans what comes from settings: valid rules only, trimmed, de-duplicated, capped. */
export function sanitizeRules(input: unknown): PermissionRules {
  const r = (input ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= MAX_RULE_LENGTH && parseRule(x) !== null))].slice(0, MAX_RULES);
  return { allow: list(r.allow), deny: list(r.deny) };
}

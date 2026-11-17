/** Removes secrets before anything is written to the audit log or sent to the model. */

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已隐藏的私钥]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏的密钥]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[已隐藏的密钥]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[已隐藏的令牌]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, '[已隐藏的令牌]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [已隐藏]'],
  [/((?:password|passwd|pwd|secret|api[_-]?key|token|密码)\s*[:=]\s*)["']?[^\s"',;]{4,}["']?/gi, '$1[已隐藏]'],
];

const SENSITIVE_KEYS = /^(api[_-]?key|apikey|password|passwd|secret|token|authorization|cookie)$/i;

export class Redactor {
  private secrets: string[] = [];

  /** Exact strings to hide (e.g. the configured API key). */
  setSecrets(values: string[]): void {
    this.secrets = values.filter((v) => v && v.length >= 6).sort((a, b) => b.length - a.length);
  }

  text(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.split(secret).join('[已隐藏的密钥]');
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  }

  /** Deep copy with secret-looking keys and values hidden. */
  value(v: unknown, depth = 0): unknown {
    if (depth > 8) return '[…]';
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x, depth + 1));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = SENSITIVE_KEYS.test(k) ? '[已隐藏]' : this.value(x, depth + 1);
      return out;
    }
    return v;
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…（已截断，原长 ${s.length} 字符）`;
}

/** File names whose contents must not be sent to the model without an explicit, per-time confirmation. */
export function isSensitiveFile(p: string): boolean {
  const name = p.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const lower = p.toLowerCase().replace(/\\/g, '/');
  return /^\.env(\..*)?$/.test(name)
    || /\.(pem|key|p12|pfx|kdbx|keychain|ppk|ovpn|wallet)$/.test(name)
    || /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/.test(name)
    || /(password|passwd|credential|secret|密码|私钥|token)/.test(name)
    || /\/\.ssh\//.test(lower) || /\/\.aws\//.test(lower) || /\/\.gnupg\//.test(lower)
    || /(login data|cookies|local state)$/.test(name);
}

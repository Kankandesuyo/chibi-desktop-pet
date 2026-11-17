/** Small display helpers for the harness-style chat window. */

export const fmtMs = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export const fmtTok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "今天" / "昨天" / "最近 7 天" / "更早" for the session list. */
export function dayGroup(t: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return '最近 7 天';
  return '更早';
}

export function clock(t: number | string): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function shortDate(t: number): string {
  const d = new Date(t);
  return startOfDay(t) === startOfDay(Date.now()) ? clock(t) : `${d.getMonth() + 1}/${d.getDate()}`;
}

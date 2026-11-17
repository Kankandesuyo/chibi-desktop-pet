import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_DROP_ITEMS, type DropSummary } from '../shared/fileDrop';
import { isInside, realResolve } from './agent/PermissionManager';

type Stat = (p: string) => { isDirectory(): boolean } | null;

const defaultStat: Stat = (p) => { try { return fs.statSync(p); } catch { return null; } };

/**
 * Checks what the pet window says was dropped. The renderer is not trusted with paths: anything that is
 * not an absolute path to something that exists is dropped, duplicates are merged, and the list is capped.
 * `allowed` mirrors the agent's folder rule so the menu can say up front what she cannot touch.
 */
export function inspectDrop(raw: unknown, allowedRoots: string[], stat: Stat = defaultStat): DropSummary | null {
  if (!Array.isArray(raw)) return null;
  const roots = allowedRoots.map(realResolve);
  const seen = new Set<string>();
  const items: DropSummary['items'] = [];
  let skipped = 0;
  for (const v of raw.slice(0, 500)) {
    if (typeof v !== 'string' || !v || v.length > 1000 || !path.isAbsolute(v) || v.includes('\0')) { skipped++; continue; }
    const p = path.resolve(v);
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const st = stat(p);
    if (!st) { skipped++; continue; }
    if (items.length >= MAX_DROP_ITEMS) { skipped++; continue; }
    const real = realResolve(p);
    items.push({ path: p, kind: st.isDirectory() ? 'dir' : 'file', allowed: roots.some((r) => isInside(real, r)) });
  }
  skipped += Math.max(0, raw.length - 500);
  return items.length ? { items, skipped } : null;
}

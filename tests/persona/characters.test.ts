import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, CHARACTERS, isCharacterId } from '../../shared/characters';
import { buildPersona } from '../../shared/persona';

const ROOT = path.join(__dirname, '../../assets/characters');
const DIRS: Record<string, string> = { orange: ROOT, deepseek: path.join(ROOT, 'deepseek') };

/** Width, height and "has an alpha channel" from a PNG header. */
function png(file: string): { w: number; h: number; alpha: boolean } {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 6 || b[25] === 4 };
}

describe.each(CHARACTER_IDS)('character art: %s', (id) => {
  const dir = DIRS[id] as string;
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    canvas: { width: number; height: number }; fallback: string; blink: null | { closed: string };
    poses: Record<string, { file: string; mirrored?: boolean }>; states: Record<string, string[]>;
    sequences: Record<string, { frames: string[]; approximateMirroring?: boolean }>;
  };

  it('every picture exists, is transparent and sits on the shared canvas', () => {
    for (const p of Object.values(m.poses)) {
      const info = png(path.join(dir, p.file));
      expect([p.file, info.w, info.h, info.alpha]).toEqual([p.file, m.canvas.width, m.canvas.height, true]);
    }
  });

  it('states and sequences only name pictures that exist', () => {
    expect(m.poses[m.fallback]).toBeDefined();
    for (const [state, list] of Object.entries(m.states)) for (const n of list) expect([state, n, n in m.poses]).toEqual([state, n, true]);
    for (const [key, s] of Object.entries(m.sequences)) {
      expect(s.frames.length).toBeGreaterThanOrEqual(2);
      for (const n of s.frames) expect([key, n, n in m.poses]).toEqual([key, n, true]);
    }
    if (m.blink) expect(m.blink.closed in m.poses).toBe(true);
  });

  it('flipped stand-in frames are marked as such, never passed off as drawn art', () => {
    for (const [key, s] of Object.entries(m.sequences)) {
      const flipped = s.frames.some((n) => m.poses[n]?.mirrored);
      expect([key, s.approximateMirroring === true]).toEqual([key, flipped]);
    }
  });
});

describe('deepseek character', () => {
  const dir = DIRS.deepseek as string;
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    blink: unknown; missing: string[]; sequences: Record<string, { frames: string[]; frameDurationMs: number; approximateMirroring?: boolean }>;
  };

  it('uses the real four left-walk frames in order and admits what is missing', () => {
    expect(m.sequences.walkLeft?.frames).toHaveLength(14);                                  // the drawn step twice over: the arm swings once per two steps
    expect(m.sequences.walkLeft?.frames.every((f) => f.startsWith('stroll-left-'))).toBe(true);
    expect(m.sequences['run:left']?.frames).toEqual(['walk-left-1', 'walk-left-2', 'walk-left-3', 'walk-left-4']);   // running keeps the long strides
    expect(m.sequences.walkRight?.approximateMirroring).toBeUndefined();                      // walking right has its own drawings now
    expect(m.sequences['run:right']?.approximateMirroring).toBe(true);
    expect(m.blink).toEqual({ base: 'idle', closed: 'blink', pairs: { 'idle-shut': 'blink-shut' } });   // each idle mouth has its own closed-eyes twin
    expect(m.missing).toEqual(expect.arrayContaining(['run_right_original']));
    expect(m.missing).not.toContain('dragging');
    expect(CHARACTERS.deepseek.note).toMatch(/镜像/);
  });

  it('holds only its own pictures', () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const m2 = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { poses: Record<string, { file: string; grab?: number[] }> };
    expect(files).toEqual(Object.values(m2.poses).map((p) => p.file).sort());      // nothing stray, nothing from another character
    expect(files).toEqual(expect.arrayContaining(['hang.png', 'struggle.png', 'closed-smile.png', 'sleep.png']));
    expect(m2.poses.hang?.grab).toHaveLength(2);                                    // held pictures hang from the drawn hand
  });

  it('her persona describes the character that is on screen', () => {
    expect(buildPersona({ name: '小鲸', appearance: CHARACTERS.deepseek.appearance, traits: '', selfState: '' })).toMatch(/鲸鱼女仆/);
    expect(buildPersona({ name: '小橘', traits: '', selfState: '' })).toMatch(/橙色长发/);
    expect(isCharacterId('deepseek')).toBe(true);
    expect(isCharacterId('nope')).toBe(false);
  });
});

describe('window theme', () => {
  it('follows the character unless a fixed theme is chosen', async () => {
    const { resolveTheme, isThemeChoice } = await import('../../shared/characters');
    expect(resolveTheme('auto', 'orange')).toBe('orange');
    expect(resolveTheme('auto', 'deepseek')).toBe('blue');
    expect(resolveTheme('orange', 'deepseek')).toBe('orange');
    expect(resolveTheme('blue', 'orange')).toBe('blue');
    expect(isThemeChoice('auto')).toBe(true);
    expect(isThemeChoice('pink')).toBe(false);
  });
});

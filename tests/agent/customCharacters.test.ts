import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_EATING, CHARACTER_IDS, canEat, characterMeta, isCharacterId, resolveTheme, type CustomCharacterInfo } from '../../shared/characters';
import { CustomCharacters, parseUserCharacterPath, README_NAME } from '../../electron/customCharacters';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });

function setup(): CustomCharacters {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-characters-'));
  return new CustomCharacters(path.join(dir, 'characters'));
}
function folder(c: CustomCharacters, name: string, manifest: unknown, files: string[]): void {
  const root = path.join(c.dir, name);
  fs.mkdirSync(root, { recursive: true });
  if (manifest !== undefined) fs.writeFileSync(path.join(root, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const f of files) fs.writeFileSync(path.join(root, f), PNG_BYTES);
}

describe('character ids', () => {
  it('accepts built-in and safe custom ids only', () => {
    expect(isCharacterId('orange')).toBe(true);
    expect(isCharacterId('custom:我的角色')).toBe(true);
    for (const bad of ['custom:', 'custom:../x', 'custom:a/b', 'custom:a\\b', 'custom:..', 'custom:x.', 'unknown', '__proto__', null]) {
      expect(isCharacterId(bad)).toBe(false);
    }
  });

  it('falls back to the default look and theme when a custom character is gone', () => {
    const meta = characterMeta('custom:没了');
    expect(meta.missing).toBe(true);
    expect(meta.note).toMatch(/找不到/);
    expect(resolveTheme('auto', 'custom:没了')).toBe('orange');
  });
});

describe('custom characters folder', () => {
  it('lists usable folders with their label, theme and pictures, and explains broken ones', () => {
    const c = setup();
    folder(c, '海蓝', { label: '海蓝小姐', theme: 'blue', appearance: '蓝头发', icon: 'icon.png', poses: { idle: { file: 'idle.png' } } }, ['idle.png', 'icon.png']);
    folder(c, '没清单', undefined, ['idle.png']);
    folder(c, '坏清单', '{not json', ['idle.png']);
    folder(c, '没图片', { poses: {} }, []);
    const list = c.list();
    const good = list.find((x) => x.folder === '海蓝');
    expect(good).toMatchObject({ id: 'custom:海蓝', label: '海蓝小姐', theme: 'blue', appearance: '蓝头发', hasIcon: true });
    expect(good?.error).toBeUndefined();
    expect(good?.files.sort()).toEqual(['icon.png', 'idle.png']);
    expect(list.find((x) => x.folder === '没清单')?.error).toMatch(/缺少 manifest/);
    expect(list.find((x) => x.folder === '坏清单')?.error).toMatch(/格式有误/);
    expect(list.find((x) => x.folder === '没图片')?.error).toMatch(/没有 PNG/);
    expect(resolveTheme('auto', 'custom:海蓝', list)).toBe('blue');
    expect(c.iconFor('custom:海蓝')).toBe(path.join(c.dir, '海蓝', 'icon.png'));
  });

  it('serves only PNG files directly inside a character folder', () => {
    const c = setup();
    folder(c, 'a', { poses: {} }, ['idle.png']);
    fs.writeFileSync(path.join(c.dir, 'a', 'secret.txt'), 'x');
    expect(c.fileFor('a', 'idle.png')).toBe(path.join(c.dir, 'a', 'idle.png'));
    expect(c.fileFor('a', 'secret.txt')).toBeNull();
    expect(c.fileFor('a', 'manifest.json')).toBeNull();
    expect(c.fileFor('..', 'idle.png')).toBeNull();
    expect(c.fileFor('a', '../a/idle.png')).toBeNull();
    expect(c.fileFor('a', 'missing.png')).toBeNull();
    expect(parseUserCharacterPath('/user-characters/%E6%B5%B7/idle.png')).toEqual(['海', 'idle.png']);
    expect(parseUserCharacterPath('/user-characters/a/b/c.png')).toBeNull();
    expect(parseUserCharacterPath('/user-characters/%E0%A4%A/x.png')).toBeNull();
    expect(parseUserCharacterPath('/assets/x.png')).toBeNull();
  });

  it('creates a complete template folder, never overwrites one, and rejects bad input', () => {
    const c = setup();
    const made = c.create('我的角色', { label: '我的角色', poses: { idle: { file: 'idle.png' } } }, [{ name: 'idle.png', data: PNG_BYTES }]);
    expect(made).toMatchObject({ id: 'custom:我的角色', label: '我的角色', files: ['idle.png'] });
    expect(fs.existsSync(path.join(c.dir, README_NAME))).toBe(true);
    const again = c.create('我的角色', { poses: {} }, [{ name: 'idle.png', data: PNG_BYTES }]);
    expect(again.folder).toBe('我的角色 (2)');
    expect(() => c.create('../逃出去', {}, [{ name: 'idle.png', data: PNG_BYTES }])).toThrow(/名字/);
    expect(() => c.create('x', {}, [{ name: '../idle.png', data: PNG_BYTES }])).toThrow(/图片无效/);
    expect(() => c.create('x', {}, [{ name: 'run.exe', data: PNG_BYTES }])).toThrow(/图片无效/);
    expect(() => c.create('x', {}, [])).toThrow(/数量/);
    expect(fs.readdirSync(c.dir).filter((n) => n.startsWith('.creating'))).toEqual([]);
  });
});

describe('eating scene availability', () => {
  it('matches the built-in manifests', () => {
    const root = path.join(__dirname, '..', '..', 'assets', 'characters');
    const dirs: Record<string, string> = { orange: '', deepseek: 'deepseek' };
    for (const id of CHARACTER_IDS) {
      const m = JSON.parse(fs.readFileSync(path.join(root, dirs[id] ?? id, 'manifest.json'), 'utf8')) as { sequences?: Record<string, unknown> };
      expect(BUILTIN_EATING.includes(id), id).toBe(Boolean(m.sequences?.eating));
    }
    expect(canEat('deepseek')).toBe(true);
    expect(canEat('orange')).toBe(false);
  });

  it('follows the manifest of a custom character', () => {
    const base = { folder: 'x', label: 'x', appearance: '', note: '', theme: 'orange' as const, files: ['a.png'], hasIcon: false };
    const withSeq: CustomCharacterInfo = { ...base, id: 'custom:x', manifest: { sequences: { eating: { frames: ['a', 'b'] } } } };
    const without: CustomCharacterInfo = { ...base, id: 'custom:y', folder: 'y', manifest: {} };
    expect(canEat('custom:x', [withSeq, without])).toBe(true);
    expect(canEat('custom:y', [withSeq, without])).toBe(false);
    expect(canEat('custom:gone', [withSeq])).toBe(false);
  });
});

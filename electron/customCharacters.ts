import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  customCharacterId, isCustomCharacterId, isSafeFolderName, THEME_IDS, CUSTOM_PREFIX,
  type CustomCharacterInfo, type ThemeId,
} from '../shared/characters';

/** Limits that keep a broken or hostile folder from stalling the app. */
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const PNG = /^[^\\/:*?"<>|\u0000-\u001f]{1,80}\.png$/i;

export const README_NAME = '怎么换形象.txt';
const README = [
  '自定义桌宠形象',
  '================',
  '',
  '这里每个子文件夹就是一个角色。做好以后：设置 → 她自己 → 角色，选它即可，不用重新安装。',
  '',
  '最简单的做法：在设置里点「用当前角色做模板」，会在这里生成一个完整的角色文件夹，',
  '把里面的图片换成你自己的（文件名不变），再点「重新载入形象」。',
  '',
  '一个角色文件夹里需要：',
  '  manifest.json  清单：每张图是什么姿势、用在什么状态（格式见模板里的现成例子）',
  '  *.png          透明背景图片，默认画布 640×580，脚底中心在 (320, 552)，站立身高约 440 像素',
  '',
  'manifest.json 里还可以写：',
  '  "label": "名字"          设置里显示的角色名',
  '  "appearance": "外貌描述"  告诉 AI 她长什么样（聊天时会用到）',
  '  "theme": "orange" 或 "blue"  聊天和设置窗口的配色',
  '  "icon": "icon.png"       托盘和窗口图标（可选，放在同一个文件夹里）',
  '',
  '缺图没关系：清单里写了但找不到的图片会用 idle 代替，程序不会崩溃。',
  '更详细的说明：https://github.com/Kankandesuyo/chibi-desktop-pet/blob/main/docs/CUSTOM_CHARACTERS.md',
  '',
].join('\r\n');

/** User-made characters: one folder each under `dir`, read on demand and cached until refresh(). */
export class CustomCharacters {
  private cache: CustomCharacterInfo[] | null = null;

  constructor(readonly dir: string) {}

  /** Creates the folder (with a short how-to) so the user has somewhere to put things. */
  ensureDir(): string {
    fs.mkdirSync(this.dir, { recursive: true });
    const readme = path.join(this.dir, README_NAME);
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, `﻿${README}`, 'utf8');
    return this.dir;
  }

  list(): CustomCharacterInfo[] {
    if (!this.cache) this.cache = this.scan();
    return this.cache;
  }

  refresh(): CustomCharacterInfo[] {
    this.cache = null;
    return this.list();
  }

  find(id: string): CustomCharacterInfo | undefined {
    return isCustomCharacterId(id) ? this.list().find((c) => c.id === id) : undefined;
  }

  private scan(): CustomCharacterInfo[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter((e) => e.isDirectory() && isSafeFolderName(e.name))
      .map((e) => this.read(e.name))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }

  private read(folder: string): CustomCharacterInfo {
    const base: CustomCharacterInfo = {
      id: customCharacterId(folder), folder, label: folder, appearance: '', note: '', theme: 'orange', manifest: {}, files: [], hasIcon: false,
    };
    const root = path.join(this.dir, folder);
    let files: string[];
    try {
      files = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && PNG.test(e.name)).map((e) => e.name).slice(0, MAX_FILES);
    } catch { return { ...base, error: '文件夹无法读取' }; }
    const manifestFile = path.join(root, 'manifest.json');
    let manifest: Record<string, unknown>;
    try {
      if (fs.statSync(manifestFile).size > MAX_MANIFEST_BYTES) return { ...base, files, error: 'manifest.json 太大' };
      const parsed: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^﻿/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...base, files, error: 'manifest.json 不是一个对象' };
      manifest = parsed as Record<string, unknown>;
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      return { ...base, files, error: missing ? '缺少 manifest.json' : 'manifest.json 格式有误' };
    }
    if (files.length === 0) return { ...base, manifest, error: '文件夹里没有 PNG 图片' };
    const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const icon = typeof manifest.icon === 'string' ? manifest.icon : '';
    return {
      ...base,
      label: text(manifest.label, 30) || folder,
      appearance: text(manifest.appearance, 400),
      note: text(manifest.note, 200),
      theme: (THEME_IDS as readonly string[]).includes(manifest.theme as string) ? manifest.theme as ThemeId : 'orange',
      manifest,
      files,
      hasIcon: icon !== '' && files.includes(icon),
    };
  }

  /** Absolute path of one picture of one character, or null when the request is not a picture inside the folder. */
  fileFor(folder: string, file: string): string | null {
    if (!isSafeFolderName(folder) || !PNG.test(file)) return null;
    const root = path.resolve(this.dir);
    const full = path.resolve(root, folder, file);
    if (!full.startsWith(root + path.sep) || path.dirname(path.dirname(full)) !== root) return null;
    try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
  }

  iconFor(id: string): string | null {
    const c = this.find(id);
    return c && c.hasIcon && !c.error ? this.fileFor(c.folder, c.manifest.icon as string) : null;
  }

  /** Writes a new character folder (e.g. a copy of the current one to use as a template). Returns its id. */
  create(name: string, manifest: Record<string, unknown>, files: { name: string; data: Uint8Array }[]): CustomCharacterInfo {
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (!isSafeFolderName(wanted)) throw new Error('名字不能为空，不能超过 40 个字，也不能含有 \\ / : * ? " < > |');
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('角色清单无效');
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw new Error('图片数量无效');
    let total = 0;
    for (const f of files) {
      if (!f || !PNG.test(f.name) || !(f.data instanceof Uint8Array) || f.data.byteLength > MAX_FILE_BYTES) throw new Error(`图片无效：${String(f?.name)}`);
      total += f.data.byteLength;
    }
    if (total > MAX_TOTAL_BYTES) throw new Error('图片总大小超过 200 MB');
    const json = JSON.stringify(manifest, null, 2);
    if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) throw new Error('角色清单太大');

    this.ensureDir();
    let folder = wanted;
    for (let n = 2; fs.existsSync(path.join(this.dir, folder)); n++) folder = `${wanted.slice(0, 35)} (${n})`;
    const root = path.join(this.dir, folder);
    const temp = path.join(this.dir, `.creating-${process.pid}-${Date.now()}`);
    fs.mkdirSync(temp);
    try {
      for (const f of files) fs.writeFileSync(path.join(temp, f.name), f.data);
      fs.writeFileSync(path.join(temp, 'manifest.json'), json, 'utf8');
      fs.renameSync(temp, root);                     // appears complete or not at all
    } catch (err) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw err;
    }
    const created = this.refresh().find((c) => c.folder === folder);
    if (!created) throw new Error('角色文件夹写好了，但读不出来');
    return created;
  }
}

/** URL path the renderer uses for a custom character's picture (served by the app:// protocol). */
export const USER_CHARACTERS_PATH = '/user-characters/';

/** "/user-characters/<folder>/<file>" -> [folder, file], or null. */
export function parseUserCharacterPath(pathname: string): [string, string] | null {
  if (!pathname.startsWith(USER_CHARACTERS_PATH)) return null;
  const parts = pathname.slice(USER_CHARACTERS_PATH.length).split('/');
  if (parts.length !== 2) return null;
  try { return [decodeURIComponent(parts[0] as string), decodeURIComponent(parts[1] as string)]; } catch { return null; }
}

export { CUSTOM_PREFIX };

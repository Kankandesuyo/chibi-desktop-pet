import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSensitiveFile } from '../redact';
import { TaskVerifier } from '../TaskVerifier';
import { defineTool, type AnyTool, type ToolContext } from '../types';

const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'appdata', '.cache', '__pycache__', '.venv', 'venv']);
const BAD_NAME = /[\\/:*?"<>|]/;
const exists = (p: string): boolean => fs.existsSync(p);
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** "a.txt" -> "a (2).txt", "a (3).txt"… until free. */
export function freeName(p: string): string {
  if (!exists(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 2; i < 1000; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!exists(c)) return c;
  }
  throw new Error('找不到可用的文件名');
}

/** rename, falling back to copy+delete across drives. */
function moveSync(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true });
  }
}

/** If `to` is an existing folder, the item goes inside it. */
function destinationFor(from: string, to: string): string {
  return isDir(to) ? path.join(to, path.basename(from)) : to;
}

function countItems(dir: string, limit = 5000): number {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < limit) {
    const d = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) { n++; if (e.isDirectory()) stack.push(path.join(d, e.name)); }
  }
  return n;
}

const p = (ctx: ToolContext, s: string): string => ctx.resolvePath(s);

// ---------------------------------------------------------------------------------------------

const listDirectory = defineTool<{ path: string; includeHidden?: boolean; limit?: number }>({
  name: 'list_directory', group: 'files', riskLevel: 'low', requiresConfirmation: false,
  description: '列出文件夹里的文件和子文件夹（名称、类型、大小、修改时间）。',
  inputSchema: { type: 'object', properties: {
    path: { type: 'string', description: '文件夹的绝对路径' },
    includeHidden: { type: 'boolean', description: '是否包含以 . 开头的隐藏项，默认否' },
    limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最多返回多少项，默认 300' },
  }, required: ['path'] },
  title: (a) => `查看文件夹 ${a.path}`,
  paths: (a, ctx) => ({ read: [p(ctx, a.path)] }),
  execute: async (a, ctx) => {
    const dir = p(ctx, a.path);
    if (!isDir(dir)) return { ok: false, summary: '不是文件夹', error: `${dir} 不存在或不是文件夹` };
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => a.includeHidden || !e.name.startsWith('.'));
    const limit = a.limit ?? 300;
    const items = entries.slice(0, limit).map((e) => {
      const full = path.join(dir, e.name);
      let size = 0; let modified = '';
      try { const st = fs.statSync(full); size = st.size; modified = st.mtime.toISOString(); } catch { /* unreadable */ }
      return { name: e.name, type: e.isDirectory() ? 'folder' : 'file', ext: e.isDirectory() ? '' : path.extname(e.name).toLowerCase(), size: e.isDirectory() ? undefined : size, modified };
    });
    return { ok: true, summary: `${dir} 里有 ${entries.length} 项${entries.length > limit ? `（只列出前 ${limit} 项）` : ''}`, data: { path: dir, total: entries.length, items } };
  },
});

const searchFiles = defineTool<{ root: string; nameContains?: string; extensions?: string[]; modifiedWithinDays?: number; modifiedAfter?: string; modifiedBefore?: string; maxDepth?: number; maxResults?: number; type?: 'file' | 'folder' | 'any' }>({
  name: 'search_files', group: 'files', riskLevel: 'low', requiresConfirmation: false,
  description: '在一个文件夹（含子文件夹）里按名称、扩展名、修改时间搜索文件。例如“昨天下载的 PDF”：root=下载文件夹, extensions=[".pdf"], modifiedAfter/modifiedBefore=昨天的起止时间。',
  inputSchema: { type: 'object', properties: {
    root: { type: 'string', description: '从哪个文件夹开始搜' },
    nameContains: { type: 'string', description: '文件名包含的文字（不区分大小写）' },
    extensions: { type: 'array', items: { type: 'string' }, maxItems: 30, description: '扩展名列表，如 [".pdf", ".docx"]' },
    modifiedWithinDays: { type: 'number', minimum: 0, maximum: 3650, description: '最近 N 天内修改过' },
    modifiedAfter: { type: 'string', description: 'ISO 时间，修改时间晚于它' },
    modifiedBefore: { type: 'string', description: 'ISO 时间，修改时间早于它' },
    maxDepth: { type: 'integer', minimum: 0, maximum: 10, description: '子文件夹深度，默认 5' },
    maxResults: { type: 'integer', minimum: 1, maximum: 500, description: '默认 100' },
    type: { type: 'string', enum: ['file', 'folder', 'any'], description: '默认 file' },
  }, required: ['root'] },
  title: (a) => `搜索 ${a.root}${a.nameContains ? ` 中的“${a.nameContains}”` : ''}`,
  paths: (a, ctx) => ({ read: [p(ctx, a.root)] }),
  execute: async (a, ctx) => {
    const root = p(ctx, a.root);
    if (!isDir(root)) return { ok: false, summary: '搜索目录不存在', error: `${root} 不存在或不是文件夹` };
    const exts = (a.extensions ?? []).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
    const needle = a.nameContains?.toLowerCase();
    const after = a.modifiedAfter ? Date.parse(a.modifiedAfter) : a.modifiedWithinDays !== undefined ? Date.now() - a.modifiedWithinDays * 86_400_000 : -Infinity;
    const before = a.modifiedBefore ? Date.parse(a.modifiedBefore) : Infinity;
    if (Number.isNaN(after) || Number.isNaN(before)) return { ok: false, summary: '时间格式不对', error: 'modifiedAfter/modifiedBefore 需要 ISO 时间' };
    const want = a.type ?? 'file';
    const maxDepth = a.maxDepth ?? 5;
    const maxResults = a.maxResults ?? 100;
    const deadline = Date.now() + 20_000;
    const results: { path: string; type: string; size?: number; modified: string }[] = [];
    let visited = 0; let truncated = false;
    const stack: [string, number][] = [[root, 0]];
    while (stack.length) {
      if (ctx.signal.aborted || Date.now() > deadline || visited > 60_000) { truncated = true; break; }
      const [dir, depth] = stack.pop() as [string, number];
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        visited++;
        const full = path.join(dir, e.name);
        const folder = e.isDirectory();
        if (folder && depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase())) stack.push([full, depth + 1]);
        if ((want === 'file' && folder) || (want === 'folder' && !folder)) continue;
        if (needle && !e.name.toLowerCase().includes(needle)) continue;
        if (exts.length && (folder || !exts.includes(path.extname(e.name).toLowerCase()))) continue;
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        const t = st.mtimeMs;
        if (t < after || t > before) continue;
        results.push({ path: full, type: folder ? 'folder' : 'file', size: folder ? undefined : st.size, modified: st.mtime.toISOString() });
        if (results.length >= maxResults) { truncated = true; break; }
      }
      if (results.length >= maxResults) break;
    }
    results.sort((x, y) => y.modified.localeCompare(x.modified));
    return { ok: true, summary: `找到 ${results.length} 个结果${truncated ? '（结果可能不完整）' : ''}`, data: { root, count: results.length, truncated, results } };
  },
});

const createDirectory = defineTool<{ path: string }>({
  name: 'create_directory', group: 'files', riskLevel: 'medium', requiresConfirmation: false,
  description: '新建文件夹（会同时创建缺少的上级文件夹）。已存在则什么都不做。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: '新文件夹的绝对路径' } }, required: ['path'] },
  title: (a) => `新建文件夹 ${a.path}`,
  paths: (a, ctx) => ({ write: [p(ctx, a.path)] }),
  execute: async (a, ctx) => {
    const dir = p(ctx, a.path);
    if (exists(dir)) {
      return isDir(dir) ? { ok: true, summary: `文件夹已存在：${dir}`, data: { path: dir, created: false } } : { ok: false, summary: '同名文件已存在', error: `${dir} 是一个文件` };
    }
    fs.mkdirSync(dir, { recursive: true });
    ctx.services.journal.record(ctx.taskId, 'create_directory', [{ kind: 'create', path: dir, isDir: true }]);
    return { ok: true, summary: `已创建文件夹 ${dir}`, data: { path: dir, created: true } };
  },
  verify: async (a, _r, ctx) => ({ verified: isDir(p(ctx, a.path)), detail: isDir(p(ctx, a.path)) ? '文件夹存在' : '文件夹不存在' }),
});

const createFile = defineTool<{ path: string; content?: string }>({
  name: 'create_file', group: 'files', riskLevel: 'medium', requiresConfirmation: false,
  description: '新建文本文件（文件已存在时失败；要改已有文件请用 write_file）。',
  inputSchema: { type: 'object', properties: {
    path: { type: 'string', description: '新文件的绝对路径' },
    content: { type: 'string', maxLength: 500_000, description: '文件内容（UTF-8 文本）' },
  }, required: ['path'] },
  title: (a) => `新建文件 ${a.path}`,
  paths: (a, ctx) => ({ write: [p(ctx, a.path)] }),
  execute: async (a, ctx) => {
    const file = p(ctx, a.path);
    if (exists(file)) return { ok: false, summary: '文件已存在', error: `${file} 已存在，如需修改请用 write_file` };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, a.content ?? '', { encoding: 'utf8', flag: 'wx' });
    ctx.services.journal.record(ctx.taskId, 'create_file', [{ kind: 'create', path: file, isDir: false }]);
    return { ok: true, summary: `已创建 ${file}`, data: { path: file, bytes: Buffer.byteLength(a.content ?? '') } };
  },
  verify: async (a, _r, ctx) => {
    const file = p(ctx, a.path);
    const ok = exists(file) && fs.readFileSync(file, 'utf8') === (a.content ?? '');
    return { verified: ok, detail: ok ? '文件存在且内容一致' : '文件不存在或内容不一致' };
  },
});

const readFile = defineTool<{ path: string; maxChars?: number }>({
  name: 'read_file', group: 'files', riskLevel: 'low', requiresConfirmation: false,
  description: '读取文本文件内容（内容会发送给 AI 模型）。二进制文件不能读。',
  inputSchema: { type: 'object', properties: {
    path: { type: 'string' },
    maxChars: { type: 'integer', minimum: 100, maximum: 100_000, description: '最多读多少字符，默认 20000' },
  }, required: ['path'] },
  title: (a) => `读取 ${a.path}`,
  paths: (a, ctx) => ({ read: [p(ctx, a.path)] }),
  assess: (a, ctx) => (isSensitiveFile(p(ctx, a.path))
    ? { risk: 'high', reason: '这个文件可能含有密码、密钥或登录信息，读取后内容会发送给 AI 模型', preview: [`读取并发送给模型：${p(ctx, a.path)}`] }
    : { risk: 'low' }),
  execute: async (a, ctx) => {
    const file = p(ctx, a.path);
    if (!exists(file) || isDir(file)) return { ok: false, summary: '文件不存在', error: `${file} 不存在或是文件夹` };
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const max = a.maxChars ?? 20_000;
    const buf = Buffer.alloc(Math.min(size, max * 4));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.subarray(0, 8192).includes(0)) return { ok: false, summary: '二进制文件', error: '这是二进制文件，不能作为文本读取' };
    let text = buf.toString('utf8');
    const truncated = text.length > max || buf.length < size;
    text = text.slice(0, max);
    return { ok: true, summary: `读取了 ${file}（${fmtSize(size)}）${truncated ? '，只读了前面部分' : ''}`, data: { path: file, size, truncated, content: text }, external: true };
  },
});

const writeFile = defineTool<{ path: string; content: string; mode?: 'overwrite' | 'append' }>({
  name: 'write_file', group: 'files', riskLevel: 'medium', requiresConfirmation: false,
  description: '写入文本文件。文件不存在就新建；mode=overwrite 覆盖（覆盖前自动备份，属于高风险），mode=append 追加。',
  inputSchema: { type: 'object', properties: {
    path: { type: 'string' },
    content: { type: 'string', maxLength: 500_000 },
    mode: { type: 'string', enum: ['overwrite', 'append'], description: '默认 overwrite' },
  }, required: ['path', 'content'] },
  title: (a) => `${a.mode === 'append' ? '追加写入' : '写入'} ${a.path}`,
  paths: (a, ctx) => ({ write: [p(ctx, a.path)] }),
  assess: (a, ctx) => {
    const file = p(ctx, a.path);
    if (exists(file) && (a.mode ?? 'overwrite') === 'overwrite') {
      return { risk: 'high', reason: '会覆盖已有文件的全部内容（会先自动备份）', preview: [`覆盖：${file}（原大小 ${fmtSize(fs.statSync(file).size)}）`, `新内容：${a.content.length} 字符`, a.content.slice(0, 200)] };
    }
    return { risk: 'medium', preview: [`${exists(file) ? '追加到' : '新建'}：${file}`, a.content.slice(0, 200)] };
  },
  execute: async (a, ctx) => {
    const file = p(ctx, a.path);
    if (isDir(file)) return { ok: false, summary: '目标是文件夹', error: `${file} 是文件夹` };
    const existed = exists(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if ((a.mode ?? 'overwrite') === 'append') {
      if (existed) ctx.services.journal.record(ctx.taskId, 'write_file', [{ kind: 'overwrite', path: file, backup: ctx.services.journal.backup(file) }]);
      fs.appendFileSync(file, a.content, 'utf8');
    } else {
      if (existed) ctx.services.journal.record(ctx.taskId, 'write_file', [{ kind: 'overwrite', path: file, backup: ctx.services.journal.backup(file) }]);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, a.content, 'utf8');
      fs.renameSync(tmp, file);
    }
    if (!existed) ctx.services.journal.record(ctx.taskId, 'write_file', [{ kind: 'create', path: file, isDir: false }]);
    return { ok: true, summary: `已写入 ${file}`, data: { path: file, existed, bytes: fs.statSync(file).size } };
  },
  verify: async (a, _r, ctx) => {
    const content = fs.readFileSync(p(ctx, a.path), 'utf8');
    const ok = (a.mode ?? 'overwrite') === 'append' ? content.endsWith(a.content) : content === a.content;
    return { verified: ok, detail: ok ? '内容已写入' : '读回的内容和预期不一致' };
  },
});

const moveFile = defineTool<{ from: string; to: string; overwrite?: boolean }>({
  name: 'move_file', group: 'files', riskLevel: 'medium', requiresConfirmation: false,
  description: '移动一个文件或文件夹。to 是已存在的文件夹时放进去；否则作为新的完整路径。默认不覆盖同名文件。',
  inputSchema: { type: 'object', properties: {
    from: { type: 'string' }, to: { type: 'string' },
    overwrite: { type: 'boolean', description: '目标已存在时是否覆盖（高风险），默认否' },
  }, required: ['from', 'to'] },
  title: (a) => `移动 ${path.basename(a.from)} → ${a.to}`,
  paths: (a, ctx) => ({ remove: [p(ctx, a.from)], write: [destinationFor(p(ctx, a.from), p(ctx, a.to))] }),
  assess: (a, ctx) => {
    const dest = destinationFor(p(ctx, a.from), p(ctx, a.to));
    if (exists(dest) && a.overwrite) return { risk: 'high', reason: '目标位置已有同名项，会被覆盖（会先备份）', preview: [`${p(ctx, a.from)} → ${dest}（覆盖）`] };
    return { risk: 'medium', preview: [`${p(ctx, a.from)} → ${dest}`] };
  },
  execute: async (a, ctx) => {
    const from = p(ctx, a.from);
    const dest = destinationFor(from, p(ctx, a.to));
    if (!exists(from)) return { ok: false, summary: '源文件不存在', error: `${from} 不存在` };
    const ops = [];
    if (exists(dest)) {
      if (!a.overwrite) return { ok: false, summary: '目标已存在', error: `${dest} 已存在。可以换个名字，或明确要求覆盖` };
      if (isDir(dest)) return { ok: false, summary: '不能覆盖文件夹', error: `${dest} 是文件夹，不能被覆盖` };
      ops.push({ kind: 'overwrite' as const, path: dest, backup: ctx.services.journal.backup(dest) });
      fs.unlinkSync(dest);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    moveSync(from, dest);
    ctx.services.journal.record(ctx.taskId, 'move_file', [...ops, { kind: 'move', from, to: dest }]);
    return { ok: true, summary: `已移动到 ${dest}`, data: { from, to: dest } };
  },
  verify: async (a, r, ctx) => {
    const to = (r.data as { to: string }).to;
    const ok = exists(to) && !exists(p(ctx, a.from));
    return { verified: ok, detail: ok ? '文件已在新位置' : '新位置没有文件或原位置仍有文件' };
  },
});

interface MoveItem { from: string; toFolder: string }
interface MoveOutcome { from: string; to?: string; status: 'moved' | 'skipped' | 'failed'; reason?: string }

const moveFiles = defineTool<{ moves: MoveItem[]; onConflict?: 'skip' | 'rename' }>({
  name: 'move_files', group: 'files', riskLevel: 'medium', requiresConfirmation: false,
  description: '批量把多个文件/文件夹移动到目标文件夹（目标文件夹不存在会自动创建）。用于整理桌面、按类型归类等。会先给用户看完整预览；超过 20 项算高风险。重名时默认自动改名为“名字 (2)”。',
  inputSchema: { type: 'object', properties: {
    moves: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', properties: { from: { type: 'string' }, toFolder: { type: 'string' } }, required: ['from', 'toFolder'] } },
    onConflict: { type: 'string', enum: ['skip', 'rename'], description: '目标已有同名项时：skip 跳过，rename 自动改名（默认）' },
  }, required: ['moves'] },
  title: (a) => `批量移动 ${a.moves.length} 项`,
  paths: (a, ctx) => ({ remove: a.moves.map((m) => p(ctx, m.from)), write: a.moves.map((m) => p(ctx, m.toFolder)) }),
  assess: (a, ctx) => {
    const byFolder = new Map<string, string[]>();
    for (const m of a.moves) {
      const k = p(ctx, m.toFolder);
      byFolder.set(k, [...(byFolder.get(k) ?? []), path.basename(p(ctx, m.from))]);
    }
    const preview = [...byFolder.entries()].map(([folder, names]) => `→ ${folder}（${names.length} 项）：${names.slice(0, 8).join('、')}${names.length > 8 ? ' …' : ''}`);
    const missing = a.moves.filter((m) => !exists(p(ctx, m.from))).length;
    if (missing) preview.push(`注意：有 ${missing} 项源文件不存在，会被跳过`);
    return a.moves.length > 20
      ? { risk: 'high', reason: `一次移动 ${a.moves.length} 项，属于大规模修改`, preview }
      : { risk: 'medium', preview };
  },
  execute: async (a, ctx) => {
    const outcomes: MoveOutcome[] = [];
    const journalOps: { kind: 'move'; from: string; to: string }[] = [];
    const createdDirs: { kind: 'create'; path: string; isDir: true }[] = [];
    for (const m of a.moves) {
      if (ctx.signal.aborted) { outcomes.push({ from: m.from, status: 'skipped', reason: '任务已取消' }); continue; }
      const from = p(ctx, m.from);
      const folder = p(ctx, m.toFolder);
      try {
        if (!exists(from)) { outcomes.push({ from, status: 'skipped', reason: '源文件不存在' }); continue; }
        if (exists(folder) && !isDir(folder)) { outcomes.push({ from, status: 'failed', reason: `${folder} 不是文件夹` }); continue; }
        if (!exists(folder)) { fs.mkdirSync(folder, { recursive: true }); createdDirs.push({ kind: 'create', path: folder, isDir: true }); }
        let dest = path.join(folder, path.basename(from));
        if (path.resolve(dest) === path.resolve(from)) { outcomes.push({ from, status: 'skipped', reason: '已经在目标文件夹里' }); continue; }
        if (exists(dest)) {
          if ((a.onConflict ?? 'rename') === 'skip') { outcomes.push({ from, status: 'skipped', reason: '目标已有同名项' }); continue; }
          dest = freeName(dest);
        }
        moveSync(from, dest);
        journalOps.push({ kind: 'move', from, to: dest });
        outcomes.push({ from, to: dest, status: 'moved' });
      } catch (err) {
        outcomes.push({ from, status: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    ctx.services.journal.record(ctx.taskId, 'move_files', [...createdDirs, ...journalOps]);
    const moved = outcomes.filter((o) => o.status === 'moved').length;
    const skipped = outcomes.filter((o) => o.status === 'skipped').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    return {
      ok: failed === 0,
      summary: `移动成功 ${moved} 项，跳过 ${skipped} 项，失败 ${failed} 项`,
      data: { moved, skipped, failed, outcomes },
      error: failed ? `${failed} 项移动失败，已移动的文件可用 undo_file_operations 撤销` : undefined,
    };
  },
  verify: async (_a, r) => {
    const outcomes = (r.data as { outcomes: MoveOutcome[] }).outcomes;
    const bad = outcomes.filter((o) => o.status === 'moved' && (!o.to || !exists(o.to) || exists(o.from)));
    return { verified: bad.length === 0, detail: bad.length ? `${bad.length} 项不在预期位置` : `已逐个确认 ${outcomes.filter((o) => o.status === 'moved').length} 项在新位置` };
  },
});

const copyFile = defineTool<{ from: string; to: string; overwrite?: boolean }>({
  name: 'copy_file', group: 'files', riskLevel: 'medium', requiresConfirmation: false,
  description: '复制文件或文件夹。to 是已存在的文件夹时复制到里面。默认不覆盖。',
  inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['from', 'to'] },
  title: (a) => `复制 ${path.basename(a.from)} → ${a.to}`,
  paths: (a, ctx) => ({ read: [p(ctx, a.from)], write: [destinationFor(p(ctx, a.from), p(ctx, a.to))] }),
  assess: (a, ctx) => {
    const dest = destinationFor(p(ctx, a.from), p(ctx, a.to));
    return exists(dest) && a.overwrite ? { risk: 'high', reason: '会覆盖已有文件', preview: [`${p(ctx, a.from)} → ${dest}（覆盖）`] } : { risk: 'medium', preview: [`${p(ctx, a.from)} → ${dest}`] };
  },
  execute: async (a, ctx) => {
    const from = p(ctx, a.from);
    const dest = destinationFor(from, p(ctx, a.to));
    if (!exists(from)) return { ok: false, summary: '源文件不存在', error: `${from} 不存在` };
    if (exists(dest) && !a.overwrite) return { ok: false, summary: '目标已存在', error: `${dest} 已存在` };
    const ops = [];
    if (exists(dest)) { if (isDir(dest)) return { ok: false, summary: '不能覆盖文件夹', error: `${dest} 是文件夹` }; ops.push({ kind: 'overwrite' as const, path: dest, backup: ctx.services.journal.backup(dest) }); }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(from, dest, { recursive: true, force: Boolean(a.overwrite) });
    if (!ops.length) ops.push({ kind: 'create' as const, path: dest, isDir: isDir(dest) });
    ctx.services.journal.record(ctx.taskId, 'copy_file', ops);
    return { ok: true, summary: `已复制到 ${dest}`, data: { from, to: dest } };
  },
  verify: async (_a, r) => { const to = (r.data as { to: string }).to; return { verified: exists(to), detail: exists(to) ? '副本存在' : '副本不存在' }; },
});

const renameFile = defineTool<{ path: string; newName: string }>({
  name: 'rename_file', group: 'files', riskLevel: 'medium', requiresConfirmation: false,
  description: '重命名文件或文件夹（只改名字，不换位置）。',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, newName: { type: 'string', maxLength: 200, description: '新名字（含扩展名，不含路径）' } }, required: ['path', 'newName'] },
  title: (a) => `重命名 ${path.basename(a.path)} → ${a.newName}`,
  paths: (a, ctx) => ({ remove: [p(ctx, a.path)], write: [path.join(path.dirname(p(ctx, a.path)), a.newName)] }),
  execute: async (a, ctx) => {
    const from = p(ctx, a.path);
    if (BAD_NAME.test(a.newName) || !a.newName.trim() || a.newName === '.' || a.newName === '..') return { ok: false, summary: '新名字不合法', error: '名字里不能有 \\ / : * ? " < > |' };
    const to = path.join(path.dirname(from), a.newName.trim());
    if (!exists(from)) return { ok: false, summary: '文件不存在', error: `${from} 不存在` };
    if (exists(to) && to.toLowerCase() !== from.toLowerCase()) return { ok: false, summary: '新名字已被占用', error: `${to} 已存在` };
    fs.renameSync(from, to);
    ctx.services.journal.record(ctx.taskId, 'rename_file', [{ kind: 'move', from, to }]);
    return { ok: true, summary: `已改名为 ${a.newName}`, data: { from, to } };
  },
  verify: async (_a, r) => { const { to } = r.data as { to: string }; return { verified: exists(to), detail: exists(to) ? '新名字的文件存在' : '找不到改名后的文件' }; },
});

const deleteFile = defineTool<{ path: string }>({
  name: 'delete_file', group: 'files', riskLevel: 'high', requiresConfirmation: true,
  description: '删除文件或文件夹：放入回收站（可在回收站还原）。高风险，每次都需要用户确认。',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  title: (a) => `删除 ${a.path}`,
  paths: (a, ctx) => ({ remove: [p(ctx, a.path)] }),
  assess: (a, ctx) => {
    const target = p(ctx, a.path);
    const extra = isDir(target) ? `（文件夹，里面共 ${countItems(target)} 项）` : exists(target) ? `（${fmtSize(fs.statSync(target).size)}）` : '（不存在）';
    return { risk: 'high', reason: '删除操作，每次都需要确认。会放入回收站。', preview: [`放入回收站：${target}${extra}`] };
  },
  execute: async (a, ctx) => {
    const target = p(ctx, a.path);
    if (!exists(target)) return { ok: false, summary: '文件不存在', error: `${target} 不存在` };
    await ctx.platform.trash(target);
    ctx.services.journal.record(ctx.taskId, 'delete_file', [{ kind: 'trash', path: target }]);
    return { ok: true, summary: `已放入回收站：${target}`, data: { path: target } };
  },
  verify: async (a, _r, ctx) => ({ verified: !exists(p(ctx, a.path)), detail: exists(p(ctx, a.path)) ? '文件仍然存在' : '原位置已没有该文件' }),
});

const getFileInfo = defineTool<{ path: string }>({
  name: 'get_file_info', group: 'files', riskLevel: 'low', requiresConfirmation: false,
  description: '查看文件或文件夹的信息：是否存在、类型、大小、创建/修改时间。',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  title: (a) => `查看 ${a.path} 的信息`,
  paths: (a, ctx) => ({ read: [p(ctx, a.path)] }),
  execute: async (a, ctx) => {
    const target = p(ctx, a.path);
    if (!exists(target)) return { ok: true, summary: `${target} 不存在`, data: { path: target, exists: false } };
    const st = fs.statSync(target);
    const folder = st.isDirectory();
    return {
      ok: true, summary: `${folder ? '文件夹' : '文件'} ${target}${folder ? '' : `，${fmtSize(st.size)}`}`,
      data: { path: target, exists: true, type: folder ? 'folder' : 'file', size: st.size, sizeText: fmtSize(st.size), created: st.birthtime.toISOString(), modified: st.mtime.toISOString(), items: folder ? countItems(target) : undefined },
    };
  },
});

const createShortcut = defineTool<{ target: string; name: string; folder?: string; args?: string; workingDirectory?: string; description?: string }>({
  name: 'create_shortcut', group: 'files', riskLevel: 'medium', requiresConfirmation: false,
  description: '创建 Windows 快捷方式（.lnk）。target 填程序/文件/文件夹路径；填 "@pet" 表示桌宠自己（“把你的快捷方式放到桌面”）。folder 默认是桌面。',
  inputSchema: { type: 'object', properties: {
    target: { type: 'string', description: '目标路径，或 "@pet"' },
    name: { type: 'string', maxLength: 120, description: '快捷方式名字（不含 .lnk）' },
    folder: { type: 'string', description: '放在哪个文件夹，默认桌面' },
    args: { type: 'string', maxLength: 1000 },
    workingDirectory: { type: 'string' },
    description: { type: 'string', maxLength: 200 },
  }, required: ['target', 'name'] },
  title: (a) => `创建快捷方式“${a.name}”`,
  paths: (a, ctx) => ({ write: [path.join(a.folder ? p(ctx, a.folder) : ctx.platform.knownFolders().desktop, `${a.name.replace(/\.lnk$/i, '')}.lnk`)] }),
  execute: async (a, ctx) => {
    if (BAD_NAME.test(a.name)) return { ok: false, summary: '名字不合法', error: '名字里不能有 \\ / : * ? " < > |' };
    const folder = a.folder ? p(ctx, a.folder) : ctx.platform.knownFolders().desktop;
    const lnk = path.join(folder, `${a.name.replace(/\.lnk$/i, '')}.lnk`);
    let target: string; let args = a.args; let icon: string | undefined;
    if (a.target.trim() === '@pet') {
      const self = ctx.platform.selfLaunch();
      target = self.target; args = [self.args, a.args].filter(Boolean).join(' ') || undefined; icon = self.icon;
    } else {
      target = p(ctx, a.target);
      if (!exists(target)) return { ok: false, summary: '目标不存在', error: `${target} 不存在` };
    }
    const existed = exists(lnk);
    const ok = await ctx.platform.createShortcut(lnk, { target, args, cwd: a.workingDirectory ? p(ctx, a.workingDirectory) : path.dirname(target), description: a.description, icon });
    if (!ok) return { ok: false, summary: '创建快捷方式失败', error: ctx.platform.os === 'win32' ? '系统没有创建成功' : '快捷方式（.lnk）只在 Windows 上支持' };
    if (!existed) ctx.services.journal.record(ctx.taskId, 'create_shortcut', [{ kind: 'create', path: lnk, isDir: false }]);
    return { ok: true, summary: `已在 ${folder} 创建快捷方式“${path.basename(lnk)}”`, data: { shortcut: lnk, target, args } };
  },
  verify: async (_a, r) => { const s = (r.data as { shortcut: string }).shortcut; return { verified: exists(s), detail: exists(s) ? '快捷方式文件存在' : '快捷方式文件不存在' }; },
});

const undoFileOps = defineTool<{ scope?: 'last_task' | 'this_task'; entryId?: string }>({
  name: 'undo_file_operations', group: 'files', riskLevel: 'medium', requiresConfirmation: true,
  description: '撤销之前由桌宠做的文件操作（移回移动过的文件、恢复被覆盖的文件、删掉新建的空文件夹）。scope=this_task 撤销本次任务里的操作，last_task 撤销最近一次任务。',
  inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['last_task', 'this_task'] }, entryId: { type: 'string' } } },
  title: (a) => `撤销${a.scope === 'this_task' ? '本次任务' : '上一次任务'}的文件操作`,
  paths: (a, ctx) => ({ write: ctx.services.journal.describe(selector(a, ctx)).paths }),
  assess: (a, ctx) => {
    const d = ctx.services.journal.describe(selector(a, ctx));
    return { risk: 'medium', preview: d.lines.length ? d.lines.slice(0, 40) : ['没有可撤销的操作'] };
  },
  execute: async (a, ctx) => {
    const r = ctx.services.journal.undo(selector(a, ctx));
    if (r.done.length === 0 && r.failed.length === 0) return { ok: false, summary: '没有可撤销的操作', error: '没有找到记录' };
    return { ok: r.failed.length === 0, summary: `撤销完成 ${r.done.length} 项${r.failed.length ? `，${r.failed.length} 项未能撤销` : ''}`, data: r, error: r.failed.length ? r.failed.join('；') : undefined };
  },
});

function selector(a: { scope?: string; entryId?: string }, ctx: ToolContext): { taskId?: string; entryId?: string } {
  if (a.entryId) return { entryId: a.entryId };
  return a.scope === 'this_task' ? { taskId: ctx.taskId } : {};
}

/** Exposed for the self-check tool and tests. */
export const fileHelpers = { freeName, destinationFor, waitFor: TaskVerifier.waitFor };

export const fileTools: AnyTool[] = [listDirectory, searchFiles, createDirectory, createFile, readFile, writeFile, moveFile, moveFiles, copyFile, renameFile, deleteFile, getFileInfo, createShortcut, undoFileOps];

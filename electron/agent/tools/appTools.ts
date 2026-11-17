import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isInside } from '../PermissionManager';
import { TaskVerifier } from '../TaskVerifier';
import { defineTool, type AnyTool, type RunningApp, type ToolContext } from '../types';

const SCRIPT_EXT = /\.(bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|msi|msp|reg|scr|hta|com|cpl)$/i;
const EXEC_EXT = /\.(exe|lnk|appref-ms)$/i;

/** Targets that find_installed_app returned (this session): launching them counts as "opening a known app". */
const knownTargets = new Set<string>();

/** Absolute Windows paths and shell: targets are used as given; "~" / "%VAR%" are expanded. */
function launchTarget(t: string, ctx: ToolContext): string {
  return /^(~|%)/.test(t) || (!path.isAbsolute(t) && !/^[a-z]:\\/i.test(t) && !/^shell:/i.test(t)) ? ctx.resolvePath(t) : t;
}

function startMenuDirs(): string[] {
  const out: string[] = [];
  if (process.env.ProgramData) out.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu'));
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu'));
  return out;
}

function isKnownApp(target: string): boolean {
  const t = target.toLowerCase();
  return knownTargets.has(t) || t.startsWith('shell:appsfolder\\') || startMenuDirs().some((d) => isInside(target, d));
}

function nameHint(target: string): string {
  const base = target.toLowerCase().startsWith('shell:appsfolder\\') ? target.split('!').pop() ?? target : path.basename(target);
  return base.replace(/\.(exe|lnk)$/i, '').toLowerCase();
}

function matchesHint(app: RunningApp, hint: string): boolean {
  const n = app.name.toLowerCase();
  const t = app.title.toLowerCase();
  return Boolean(hint) && (n.includes(hint) || hint.includes(n) || t.includes(hint));
}

const listRunningApps = defineTool<Record<string, never>>({
  name: 'list_running_apps', group: 'apps', riskLevel: 'low', requiresConfirmation: false,
  description: '列出正在运行、有窗口的程序（进程名、PID、窗口标题）。',
  inputSchema: { type: 'object', properties: {} },
  title: () => '查看正在运行的程序',
  execute: async (_a, ctx) => {
    const apps = await ctx.platform.listRunningApps();
    return { ok: true, summary: `有 ${apps.length} 个带窗口的程序在运行`, data: apps.map((x) => ({ pid: x.pid, name: x.name, title: x.title })) };
  },
});

const findInstalledApp = defineTool<{ query: string }>({
  name: 'find_installed_app', group: 'apps', riskLevel: 'low', requiresConfirmation: false,
  description: '按名字查找已安装的程序（开始菜单快捷方式、应用商店应用、注册的程序路径）。返回的 target 可直接给 launch_application。中文名查不到时可以试英文名或简称，例如 "Visual Studio Code"、"Code"。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['query'] },
  title: (a) => `查找程序“${a.query}”`,
  execute: async (a, ctx) => {
    const apps = await ctx.platform.findInstalledApps(a.query.trim());
    for (const x of apps) knownTargets.add(x.target.toLowerCase());
    return apps.length
      ? { ok: true, summary: `找到 ${apps.length} 个匹配的程序`, data: apps }
      : { ok: true, summary: `没有找到名字包含“${a.query}”的程序`, data: [] };
  },
});

const launchApplication = defineTool<{ target: string; args?: string[]; workingDirectory?: string }>({
  name: 'launch_application', group: 'apps', riskLevel: 'low', requiresConfirmation: false,
  description: '启动程序。target 用 find_installed_app 返回的 target（快捷方式路径、shell:AppsFolder\\… 或 exe 路径）。args 是启动参数，例如用 VS Code 打开文件夹：args=["D:\\\\项目\\\\xxx"]。不能用来运行脚本或安装包。',
  inputSchema: { type: 'object', properties: {
    target: { type: 'string' },
    args: { type: 'array', items: { type: 'string', maxLength: 1000 }, maxItems: 20 },
    workingDirectory: { type: 'string' },
  }, required: ['target'] },
  title: (a) => `启动 ${nameHint(a.target) || a.target}`,
  assess: (a, ctx) => {
    const t = a.target.trim();
    if (SCRIPT_EXT.test(t)) return { risk: 'high', reason: '这是脚本或安装程序，运行它可能修改系统', preview: [`运行：${t} ${(a.args ?? []).join(' ')}`] };
    const f = ctx.platform.knownFolders();
    const resolved = launchTarget(t, ctx);
    if (!t.toLowerCase().startsWith('shell:') && [f.downloads, f.temp, f.desktop].some((d) => isInside(resolved, d)) && /\.exe$/i.test(t)) {
      return { risk: 'high', reason: '这是下载/临时目录里的程序，来源未知', preview: [`运行：${resolved}`] };
    }
    if (isKnownApp(resolved) && !(a.args?.length)) return { risk: 'low' };
    return { risk: 'medium', reason: a.args?.length ? '带参数启动程序' : '启动一个不在开始菜单里的程序', preview: [`启动：${resolved}`, ...(a.args?.length ? [`参数：${a.args.join(' ')}`] : [])] };
  },
  execute: async (a, ctx) => {
    const t = a.target.trim();
    if (SCRIPT_EXT.test(t)) {
      // Even after confirmation we do not run scripts through this tool: there is run_command for that.
      return { ok: false, summary: '不能用 launch_application 运行脚本', error: '脚本/安装包请改用 run_command（会显示完整命令并要求确认）' };
    }
    const target = launchTarget(t, ctx);
    if (!target.toLowerCase().startsWith('shell:') && !EXEC_EXT.test(target)) {
      return { ok: false, summary: '不是程序', error: '要打开普通文件或文件夹请用 open_path' };
    }
    const before = await ctx.platform.listRunningApps().catch(() => [] as RunningApp[]);
    const r = await ctx.platform.launch({ target, args: a.args, cwd: a.workingDirectory ? ctx.resolvePath(a.workingDirectory) : undefined });
    return { ok: true, summary: `已发出启动 ${nameHint(target)} 的命令`, data: { target, pid: r.pid, hint: nameHint(target), before: before.map((x) => x.pid) } };
  },
  verify: async (_a, r, ctx) => {
    const d = r.data as { pid?: number; hint: string; before: number[] };
    let found: RunningApp | undefined;
    const ok = await TaskVerifier.waitFor(async () => {
      if (d.pid && (await ctx.platform.isRunning({ pid: d.pid }))) {
        found = (await ctx.platform.listRunningApps()).find((x) => x.pid === d.pid);
        if (found) return true;
      }
      const now = await ctx.platform.listRunningApps();
      found = now.find((x) => !d.before.includes(x.pid) && matchesHint(x, d.hint)) ?? now.find((x) => !d.before.includes(x.pid))
        ?? now.find((x) => matchesHint(x, d.hint));
      return Boolean(found);
    }, 15_000, 700);
    return ok ? { verified: true, detail: `检测到窗口“${found?.title ?? d.hint}”` } : { verified: false, detail: '15 秒内没有检测到程序窗口' };
  },
});

const focusApplication = defineTool<{ pid?: number; title?: string }>({
  name: 'focus_application', group: 'apps', riskLevel: 'low', requiresConfirmation: false,
  description: '把某个程序的窗口切到最前面（按 PID 或窗口标题的一部分）。',
  inputSchema: { type: 'object', properties: { pid: { type: 'integer', minimum: 1 }, title: { type: 'string', maxLength: 200 } } },
  title: (a) => `切换到 ${a.title ?? a.pid}`,
  execute: async (a, ctx) => {
    if (!a.pid && !a.title) return { ok: false, summary: '缺少参数', error: '需要 pid 或 title' };
    const ok = await ctx.platform.focus({ pid: a.pid, title: a.title });
    return ok ? { ok: true, summary: '窗口已切到前台' } : { ok: false, summary: '没能切换窗口', error: '找不到这个窗口，或系统不允许切换前台窗口' };
  },
});

const closeApplication = defineTool<{ pid?: number; name?: string; force?: boolean }>({
  name: 'close_application', group: 'apps', riskLevel: 'medium', requiresConfirmation: false,
  description: '关闭程序（按 PID 或进程名，如 "notepad"）。默认像点关闭按钮一样正常关闭，程序可能会询问是否保存；force=true 强制结束（可能丢失未保存内容，高风险）。',
  inputSchema: { type: 'object', properties: { pid: { type: 'integer', minimum: 1 }, name: { type: 'string', maxLength: 80 }, force: { type: 'boolean' } } },
  title: (a) => `${a.force ? '强制结束' : '关闭'} ${a.name ?? a.pid}`,
  assess: (a) => (a.force
    ? { risk: 'high', reason: '强制结束会丢失未保存的内容', preview: [`强制结束：${a.name ?? `PID ${a.pid}`}`] }
    : { risk: 'medium', preview: [`关闭：${a.name ?? `PID ${a.pid}`}（程序可能询问是否保存）`] }),
  execute: async (a, ctx) => {
    if (!a.pid && !a.name) return { ok: false, summary: '缺少参数', error: '需要 pid 或 name' };
    const n = await ctx.platform.close({ pid: a.pid, name: a.name }, Boolean(a.force));
    return n > 0 ? { ok: true, summary: `已向 ${n} 个窗口发出关闭`, data: { count: n } } : { ok: false, summary: '没有关闭任何程序', error: '找不到这个程序，或它没有可关闭的窗口' };
  },
  verify: async (a, _r, ctx) => {
    const gone = await TaskVerifier.waitFor(async () => !(await ctx.platform.isRunning({ pid: a.pid, name: a.name })), 8_000, 600);
    return gone ? { verified: true, detail: '程序已退出' } : { verified: false, detail: '程序仍在运行（可能在等你确认是否保存）' };
  },
});

const openPath = defineTool<{ path: string }>({
  name: 'open_path', group: 'apps', riskLevel: 'low', requiresConfirmation: false,
  description: '用系统默认方式打开文件夹或文件（例如在资源管理器里打开文件夹、用默认程序打开 PDF）。不用于运行程序。',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  title: (a) => `打开 ${a.path}`,
  paths: (a, ctx) => ({ read: [ctx.resolvePath(a.path)] }),
  assess: (a, ctx) => {
    const p = ctx.resolvePath(a.path);
    let dir = false; try { dir = fs.statSync(p).isDirectory(); } catch { /* checked in execute */ }
    if (!dir && (SCRIPT_EXT.test(p) || /\.exe$/i.test(p))) return { risk: 'high', reason: '打开它会运行程序或脚本', preview: [`运行：${p}`] };
    return dir ? { risk: 'low' } : { risk: 'medium', preview: [`用默认程序打开：${p}`] };
  },
  execute: async (a, ctx) => {
    const p = ctx.resolvePath(a.path);
    if (!fs.existsSync(p)) return { ok: false, summary: '路径不存在', error: `${p} 不存在` };
    if (SCRIPT_EXT.test(p)) return { ok: false, summary: '不能这样运行脚本', error: '脚本请改用 run_command' };
    const err = await ctx.platform.openPath(p);
    return err ? { ok: false, summary: '打开失败', error: err } : { ok: true, summary: `已打开 ${p}` };
  },
});

const openUrl = defineTool<{ url: string }>({
  name: 'open_url', group: 'apps', riskLevel: 'low', requiresConfirmation: false,
  description: '用默认浏览器打开网址（只允许 http/https）。要在网页上点击、填写、提取内容请用 browser_* 工具。',
  inputSchema: { type: 'object', properties: { url: { type: 'string', maxLength: 2000 } }, required: ['url'] },
  title: (a) => `打开网址 ${a.url}`,
  execute: async (a, ctx) => {
    const url = normalizeUrl(a.url);
    if (!url) return { ok: false, summary: '网址不合法', error: '只允许 http:// 或 https:// 网址' };
    await ctx.platform.openUrl(url);
    return { ok: true, summary: `已在浏览器打开 ${url}`, data: { url } };
  },
});

export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------- system ----

const getKnownFolders = defineTool<Record<string, never>>({
  name: 'get_known_folders', group: 'system', riskLevel: 'low', requiresConfirmation: false,
  description: '获取桌面、文档、下载、图片等系统文件夹的真实路径（包括被 OneDrive 重定向的情况），以及允许操作的文件夹。',
  inputSchema: { type: 'object', properties: {} },
  title: () => '查看系统文件夹位置',
  execute: async (_a, ctx: ToolContext) => {
    const { protected: _p, ...folders } = ctx.platform.knownFolders();
    return { ok: true, summary: '已获取系统文件夹路径', data: { ...folders, petShortcutTarget: '@pet' } };
  },
});

const getSystemInfo = defineTool<Record<string, never>>({
  name: 'get_system_info', group: 'system', riskLevel: 'low', requiresConfirmation: false,
  description: '获取当前时间、时区、系统版本、用户名等基本信息。',
  inputSchema: { type: 'object', properties: {} },
  title: () => '查看系统信息',
  execute: async (_a, ctx) => {
    const now = new Date();
    return { ok: true, summary: '已获取系统信息', data: {
      now: now.toISOString(), localTime: now.toLocaleString('zh-CN', { hour12: false }), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      os: ctx.platform.os, release: os.release(), user: os.userInfo().username, cpus: os.cpus().length,
      freeMemoryMB: Math.round(os.freemem() / 1048576), totalMemoryMB: Math.round(os.totalmem() / 1048576),
    } };
  },
});

export const appTools: AnyTool[] = [listRunningApps, findInstalledApp, launchApplication, focusApplication, closeApplication, openPath, openUrl];
export const systemTools: AnyTool[] = [getKnownFolders, getSystemInfo];

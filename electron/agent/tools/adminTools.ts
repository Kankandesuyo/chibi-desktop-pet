import * as path from 'node:path';
import { defineTool, type AnyTool, type ShellResult, type ToolContext } from '../types';

/**
 * System-level tools. Nothing here runs with administrator rights by default: each elevated call asks in
 * the chat (high risk, every time) AND through Windows' own UAC prompt. Values from the model are passed as
 * data to fixed scripts; only run_admin_command executes free text, and it shows that text in full first.
 */

const MIN = 60_000;
const UAC_NOTE = '确认后 Windows 还会弹出“用户账户控制（UAC）”窗口，需要再点一次“是”';

/** Patterns that deserve an extra-loud warning on the confirmation card (not blocked: it's your computer). */
const DANGER: [RegExp, string][] = [
  [/\b(format|diskpart|clear-disk|initialize-disk|remove-partition)\b/i, '格式化或修改磁盘分区'],
  [/\bbcdedit\b|\bbootrec\b/i, '修改系统启动配置'],
  [/set-mppreference\s+.*-disable|disablerealtimemonitoring|add-mppreference\s+-exclusion/i, '关闭或绕过 Windows Defender 防护'],
  [/netsh\s+advfirewall\s+set\s+.*state\s+off|set-netfirewallprofile\s+.*-enabled\s+false/i, '关闭防火墙'],
  [/enablelua|consentpromptbehavior/i, '修改用户账户控制（UAC）'],
  [/remove-item\s+.*(c:\\windows|c:\\program files|system32)|rd\s+\/s\s+.*\\windows|del\s+\/[sfq].*\\windows/i, '删除系统文件'],
  [/\bvssadmin\s+delete\b|wbadmin\s+delete/i, '删除系统还原点或备份'],
  [/reg(\.exe)?\s+delete\s+hklm\\(system|software\\microsoft\\windows)/i, '删除关键注册表项'],
  [/\b(net\s+user|net\s+localgroup\s+administrators)\b/i, '修改用户账户或管理员组'],
  [/\b(shutdown|restart-computer|stop-computer)\b/i, '关机或重启'],
  [/\binvoke-webrequest\b.*\|\s*iex|\biwr\b.*\|\s*iex|downloadstring/i, '下载并直接执行网络上的脚本'],
];

export function dangerReasons(command: string): string[] {
  return DANGER.filter(([re]) => re.test(command)).map(([, why]) => why);
}

const PACKAGE_ID = /^[A-Za-z0-9][\w.+-]{1,99}$/;
const SERVICE_NAME = /^[\w .@-]{1,100}$/;
const CRITICAL_SERVICES = new Set(['windefend', 'wuauserv', 'eventlog', 'rpcss', 'winmgmt', 'mpssvc', 'bfe', 'cryptsvc', 'dhcp', 'dnscache', 'lsm', 'samss', 'schedule', 'wscsvc', 'securityhealthservice', 'trustedinstaller']);

function shellResult(r: ShellResult, okSummary: string, maxOut = 6000) {
  const output = r.output.length > maxOut ? `…${r.output.slice(-maxOut)}` : r.output;
  if (r.cancelled) return { ok: false, summary: '已在 UAC 窗口取消', error: r.output };
  return r.ok ? { ok: true, summary: okSummary, data: { output }, external: true } : { ok: false, summary: '执行失败', error: output.slice(0, 1500) || '没有输出', data: { output }, external: true };
}

const ps = (ctx: ToolContext, script: string, input: Record<string, unknown>, elevated: boolean, timeoutMs = 2 * MIN): Promise<ShellResult> =>
  ctx.platform.powershell(script, input, { elevated, timeoutMs });

// ------------------------------------------------------------------------------- commands ----

const runAdminCommand = defineTool<{ command: string; shell?: 'powershell' | 'cmd'; workingDirectory?: string; timeoutSec?: number }>({
  name: 'run_admin_command', group: 'admin', riskLevel: 'high', requiresConfirmation: true,
  description: '以管理员身份运行一条 PowerShell 或 cmd 命令（修改系统设置、服务、网络、电源等需要管理员的操作）。每次都会显示完整命令请用户确认，并弹出 Windows UAC。不需要管理员的命令请用 run_command。',
  inputSchema: { type: 'object', properties: {
    command: { type: 'string', minLength: 1, maxLength: 4000 },
    shell: { type: 'string', enum: ['powershell', 'cmd'], description: '默认 powershell' },
    workingDirectory: { type: 'string' },
    timeoutSec: { type: 'integer', minimum: 5, maximum: 900, description: '默认 120' },
  }, required: ['command'] },
  title: (a) => `以管理员身份运行：${a.command.slice(0, 60)}`,
  paths: (a, ctx) => (a.workingDirectory ? { read: [ctx.resolvePath(a.workingDirectory)] } : {}),
  assess: (a) => {
    const danger = dangerReasons(a.command);
    return {
      risk: 'high',
      reason: `${danger.length ? `⚠ 危险操作：${danger.join('、')}。` : ''}会以管理员身份执行，影响整台电脑。${UAC_NOTE}`,
      preview: [`${a.shell === 'cmd' ? 'cmd' : 'PowerShell'}（管理员）：`, a.command, ...(a.workingDirectory ? [`工作目录：${a.workingDirectory}`] : []), `超时：${a.timeoutSec ?? 120} 秒`],
    };
  },
  execute: async (a, ctx) => {
    const script = a.shell === 'cmd'
      ? 'if ($in.cwd) { Set-Location -LiteralPath $in.cwd }; cmd.exe /d /c $in.command; if ($LASTEXITCODE) { throw "退出码 $LASTEXITCODE" }'
      : 'if ($in.cwd) { Set-Location -LiteralPath $in.cwd }; Invoke-Expression $in.command; if ($LASTEXITCODE) { throw "退出码 $LASTEXITCODE" }';
    const r = await ps(ctx, script, { command: a.command, cwd: a.workingDirectory ? ctx.resolvePath(a.workingDirectory) : null }, true, (a.timeoutSec ?? 120) * 1000);
    return shellResult(r, '管理员命令已执行');
  },
});

// ------------------------------------------------------------------------------- software ----

const wingetSearch = defineTool<{ query: string }>({
  name: 'winget_search', group: 'admin', riskLevel: 'low', requiresConfirmation: false,
  description: '用 winget 搜索可安装的软件，得到软件 Id（安装要用 Id）。查已安装的软件请用 list_installed_software。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['query'] },
  title: (a) => `搜索软件“${a.query}”`,
  execute: async (a, ctx) => shellResult(await ps(ctx, 'winget search --query $in.q --accept-source-agreements --disable-interactivity', { q: a.query }, false, 2 * MIN), '搜索完成', 5000),
});

const listInstalled = defineTool<{ filter?: string }>({
  name: 'list_installed_software', group: 'admin', riskLevel: 'low', requiresConfirmation: false,
  description: '列出已安装的软件（winget list），可按名字过滤。',
  inputSchema: { type: 'object', properties: { filter: { type: 'string', maxLength: 100 } } },
  title: (a) => `查看已安装软件${a.filter ? `“${a.filter}”` : ''}`,
  execute: async (a, ctx) => shellResult(await ps(ctx, 'if ($in.f) { winget list --query $in.f --accept-source-agreements --disable-interactivity } else { winget list --accept-source-agreements --disable-interactivity }', { f: a.filter ?? null }, false, 2 * MIN), '已列出', 8000),
});

const isInstalled = async (ctx: ToolContext, id: string): Promise<boolean> => {
  const r = await ps(ctx, 'winget list --id $in.id --exact --accept-source-agreements --disable-interactivity', { id }, false, MIN);
  return r.ok && r.output.toLowerCase().includes(id.toLowerCase());
};

const installSoftware = defineTool<{ id: string; version?: string }>({
  name: 'install_software', group: 'admin', riskLevel: 'high', requiresConfirmation: true,
  description: '用 winget 安装软件（id 先用 winget_search 查到，例如 "Microsoft.VisualStudioCode"）。需要管理员权限，每次确认。',
  inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 100 }, version: { type: 'string', maxLength: 40 } }, required: ['id'] },
  title: (a) => `安装 ${a.id}`,
  assess: (a) => ({ risk: 'high', reason: `会从 winget 软件源下载并以管理员身份安装软件。${UAC_NOTE}`, preview: [`安装：${a.id}${a.version ? ` ${a.version}` : '（最新版）'}`, '来源：winget（Microsoft 软件包管理器）'] }),
  execute: async (a, ctx) => {
    if (!PACKAGE_ID.test(a.id) || (a.version && !/^[\w.+-]{1,40}$/.test(a.version))) return { ok: false, summary: 'Id 不合法', error: '软件 Id / 版本只能包含字母、数字和 . _ + -' };
    const r = await ps(ctx, '$a = @("install","--id",$in.id,"--exact","--silent","--accept-package-agreements","--accept-source-agreements","--disable-interactivity"); if ($in.v) { $a += @("--version",$in.v) }; winget @a; if ($LASTEXITCODE) { throw "winget 退出码 $LASTEXITCODE" }', { id: a.id, v: a.version ?? null }, true, 15 * MIN);
    return shellResult(r, `已安装 ${a.id}`);
  },
  verify: async (a, _r, ctx) => (await isInstalled(ctx, a.id) ? { verified: true, detail: 'winget 列表里已有该软件' } : { verified: false, detail: 'winget 列表里找不到该软件' }),
});

const uninstallSoftware = defineTool<{ id: string }>({
  name: 'uninstall_software', group: 'admin', riskLevel: 'high', requiresConfirmation: true,
  description: '用 winget 卸载软件（id 用 list_installed_software 查）。需要管理员权限，每次确认。',
  inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 100 } }, required: ['id'] },
  title: (a) => `卸载 ${a.id}`,
  assess: (a) => ({ risk: 'high', reason: `卸载后该软件的程序文件会被删除。${UAC_NOTE}`, preview: [`卸载：${a.id}`] }),
  execute: async (a, ctx) => {
    if (!PACKAGE_ID.test(a.id)) return { ok: false, summary: 'Id 不合法', error: '软件 Id 只能包含字母、数字和 . _ + -' };
    const r = await ps(ctx, 'winget uninstall --id $in.id --exact --silent --accept-source-agreements --disable-interactivity; if ($LASTEXITCODE) { throw "winget 退出码 $LASTEXITCODE" }', { id: a.id }, true, 15 * MIN);
    return shellResult(r, `已卸载 ${a.id}`);
  },
  verify: async (a, _r, ctx) => (await isInstalled(ctx, a.id) ? { verified: false, detail: '软件仍在已安装列表里' } : { verified: true, detail: '已安装列表里没有该软件了' }),
});

const upgradeSoftware = defineTool<{ id?: string; all?: boolean }>({
  name: 'upgrade_software', group: 'admin', riskLevel: 'high', requiresConfirmation: true,
  description: '用 winget 升级一个软件（id）或全部可升级的软件（all=true）。需要管理员权限。',
  inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 100 }, all: { type: 'boolean' } } },
  title: (a) => (a.all ? '升级全部软件' : `升级 ${a.id}`),
  assess: (a) => ({ risk: 'high', reason: `会以管理员身份下载并安装新版本。${UAC_NOTE}`, preview: [a.all ? '升级所有可升级的软件' : `升级：${a.id}`] }),
  execute: async (a, ctx) => {
    if (!a.all && (!a.id || !PACKAGE_ID.test(a.id))) return { ok: false, summary: '缺少 Id', error: '需要合法的 id，或 all=true' };
    const r = await ps(ctx, 'if ($in.all) { winget upgrade --all --silent --accept-package-agreements --accept-source-agreements --disable-interactivity } else { winget upgrade --id $in.id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity }; if ($LASTEXITCODE) { throw "winget 退出码 $LASTEXITCODE" }', { id: a.id ?? null, all: Boolean(a.all) }, true, 30 * MIN);
    return shellResult(r, '升级完成');
  },
});

// ------------------------------------------------------------------------------- services ----

const manageService = defineTool<{ name: string; action: 'status' | 'start' | 'stop' | 'restart' | 'set_startup'; startupType?: 'Automatic' | 'Manual' | 'Disabled' }>({
  name: 'manage_service', group: 'admin', riskLevel: 'low', requiresConfirmation: false,
  description: '查看或管理 Windows 服务：status 查看（不需要管理员）；start/stop/restart/set_startup 需要管理员、每次确认。',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', maxLength: 100, description: '服务名（如 Spooler）或显示名' },
    action: { type: 'string', enum: ['status', 'start', 'stop', 'restart', 'set_startup'] },
    startupType: { type: 'string', enum: ['Automatic', 'Manual', 'Disabled'] },
  }, required: ['name', 'action'] },
  title: (a) => `${({ status: '查看', start: '启动', stop: '停止', restart: '重启', set_startup: '设置启动方式' } as const)[a.action]}服务 ${a.name}`,
  assess: (a) => {
    if (a.action === 'status') return { risk: 'low' };
    const critical = CRITICAL_SERVICES.has(a.name.toLowerCase()) && (a.action === 'stop' || a.startupType === 'Disabled');
    return { risk: 'high', reason: `${critical ? '⚠ 这是系统关键服务，停用可能影响安全或系统稳定。' : ''}需要管理员权限。${UAC_NOTE}`, preview: [`服务：${a.name}`, `操作：${a.action}${a.startupType ? ` → ${a.startupType}` : ''}`] };
  },
  execute: async (a, ctx) => {
    if (!SERVICE_NAME.test(a.name)) return { ok: false, summary: '服务名不合法', error: '服务名包含不允许的字符' };
    if (a.action === 'set_startup' && !a.startupType) return { ok: false, summary: '缺少启动方式', error: '需要 startupType' };
    if (a.action === 'status') {
      return shellResult(await ps(ctx, '$s = Get-Service -Name $in.n -ErrorAction SilentlyContinue; if (-not $s) { $s = Get-Service -DisplayName $in.n }; $s | Select-Object Name,DisplayName,Status,StartType | Format-List', { n: a.name }, false, MIN), '已获取服务状态');
    }
    const body = {
      start: 'Start-Service -Name $s.Name', stop: 'Stop-Service -Name $s.Name -Force', restart: 'Restart-Service -Name $s.Name -Force',
      set_startup: 'Set-Service -Name $s.Name -StartupType $in.t',
    }[a.action];
    const r = await ps(ctx, `$s = Get-Service -Name $in.n -ErrorAction SilentlyContinue; if (-not $s) { $s = Get-Service -DisplayName $in.n }; ${body}; Get-Service -Name $s.Name | Select-Object Name,Status,StartType | Format-List`, { n: a.name, t: a.startupType ?? null }, true, 3 * MIN);
    return shellResult(r, '服务操作已完成');
  },
  verify: async (a, _r, ctx) => {
    if (a.action === 'status') return { verified: true, detail: '只读操作' };
    const r = await ps(ctx, '$s = Get-Service -Name $in.n -ErrorAction SilentlyContinue; if (-not $s) { $s = Get-Service -DisplayName $in.n }; "$($s.Status)|$($s.StartType)"', { n: a.name }, false, MIN);
    const [status = '', start = ''] = r.output.trim().split('|');
    const ok = a.action === 'start' || a.action === 'restart' ? status === 'Running'
      : a.action === 'stop' ? status === 'Stopped' : start === a.startupType;
    return { verified: r.ok && ok, detail: `当前状态：${status || '未知'}，启动方式：${start || '未知'}` };
  },
});

// ------------------------------------------------------------------------------- registry ----

const HIVES: Record<string, string> = {
  HKEY_LOCAL_MACHINE: 'HKLM', HKLM: 'HKLM', HKEY_CURRENT_USER: 'HKCU', HKCU: 'HKCU', HKEY_CLASSES_ROOT: 'HKCR', HKCR: 'HKCR', HKEY_USERS: 'HKU', HKU: 'HKU', HKEY_CURRENT_CONFIG: 'HKCC', HKCC: 'HKCC',
};

/** "HKEY_LOCAL_MACHINE\\SOFTWARE\\X" or "HKLM:\\SOFTWARE\\X" -> { ps: "Registry::HKLM\\SOFTWARE\\X", reg: "HKLM\\SOFTWARE\\X", hive } */
export function normalizeRegPath(raw: string): { ps: string; reg: string; hive: string } | null {
  const m = /^([A-Za-z_]+):?\\+(.*)$/.exec(raw.trim().replace(/\//g, '\\'));
  if (!m) return null;
  const hive = HIVES[(m[1] ?? '').toUpperCase()];
  const rest = (m[2] ?? '').replace(/\\+$/, '');
  if (!hive || !rest || /[\0\r\n]/.test(rest)) return null;
  return { ps: `Registry::${hive}\\${rest}`, reg: `${hive}\\${rest}`, hive };
}

const registryRead = defineTool<{ path: string; name?: string }>({
  name: 'registry_read', group: 'admin', riskLevel: 'low', requiresConfirmation: false,
  description: '读取注册表键下的值（例如 HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion）。只读。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 500 }, name: { type: 'string', maxLength: 200 } }, required: ['path'] },
  title: (a) => `读取注册表 ${a.path}`,
  execute: async (a, ctx) => {
    const p = normalizeRegPath(a.path);
    if (!p) return { ok: false, summary: '路径不合法', error: '注册表路径要以 HKLM\\ / HKCU\\ 等开头' };
    return shellResult(await ps(ctx, 'if ($in.n) { Get-ItemProperty -LiteralPath $in.p -Name $in.n | Select-Object -Property $in.n | Format-List } else { Get-ItemProperty -LiteralPath $in.p | Format-List; Get-ChildItem -LiteralPath $in.p -ErrorAction SilentlyContinue | Select-Object -First 50 -ExpandProperty PSChildName }', { p: p.ps, n: a.name ?? null }, false, MIN), '已读取');
  },
});

const REG_TYPES = ['String', 'ExpandString', 'DWord', 'QWord', 'MultiString'] as const;

const registryWrite = defineTool<{ path: string; name: string; value: string; type?: (typeof REG_TYPES)[number] }>({
  name: 'registry_write', group: 'admin', riskLevel: 'high', requiresConfirmation: true,
  description: '写入注册表值（键不存在会创建）。修改前会把整个键导出备份到桌宠的备份文件夹。HKLM 等需要管理员权限，每次确认。',
  inputSchema: { type: 'object', properties: {
    path: { type: 'string', maxLength: 500 }, name: { type: 'string', maxLength: 200 },
    value: { type: 'string', maxLength: 2000, description: '数字也用字符串写，如 "1"；MultiString 用 \\n 分隔' },
    type: { type: 'string', enum: REG_TYPES, description: '默认 String' },
  }, required: ['path', 'name', 'value'] },
  title: (a) => `修改注册表 ${a.path}\\${a.name}`,
  assess: (a) => {
    const p = normalizeRegPath(a.path);
    const danger = /\\(system\\currentcontrolset|policies|windows defender|winlogon|lsa)\b/i.test(a.path);
    return { risk: 'high', reason: `${danger ? '⚠ 这是系统关键位置，改错可能导致无法登录或安全功能失效。' : ''}修改前会自动备份。${p?.hive === 'HKCU' ? '' : UAC_NOTE}`, preview: [`键：${p?.reg ?? a.path}`, `值：${a.name} = ${a.value}（${a.type ?? 'String'}）`] };
  },
  execute: async (a, ctx) => {
    const p = normalizeRegPath(a.path);
    if (!p) return { ok: false, summary: '路径不合法', error: '注册表路径要以 HKLM\\ / HKCU\\ 等开头' };
    const backup = path.join(ctx.services.journal.backupDir, `reg-${Date.now()}.reg`);
    const r = await ps(ctx, `
New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $in.backup) | Out-Null
if (Test-Path -LiteralPath $in.p) { reg.exe export $in.reg $in.backup /y | Out-Null } else { New-Item -Path $in.p -Force | Out-Null }
$v = $in.v
switch ($in.t) { 'DWord' { $v = [int]$in.v } 'QWord' { $v = [long]$in.v } 'MultiString' { $v = [string[]]($in.v -split "\`n") } }
New-ItemProperty -LiteralPath $in.p -Name $in.n -Value $v -PropertyType $in.t -Force | Out-Null
"已写入；备份：$($in.backup)"`, { p: p.ps, reg: p.reg, n: a.name, v: a.value, t: a.type ?? 'String', backup }, p.hive !== 'HKCU', 2 * MIN);
    const res = shellResult(r, `已修改 ${p.reg}\\${a.name}`);
    return { ...res, data: { ...(res.data ?? {}), backup } };
  },
  verify: async (a, _r, ctx) => {
    const p = normalizeRegPath(a.path);
    if (!p) return { verified: false, detail: '路径不合法' };
    const r = await ps(ctx, '$x = (Get-ItemProperty -LiteralPath $in.p -Name $in.n).($in.n); if ($x -is [array]) { $x -join "`n" } else { "$x" }', { p: p.ps, n: a.name }, false, MIN);
    const ok = r.ok && r.output.trim() === a.value.trim();
    return { verified: ok, detail: ok ? '读回的值正确' : `读回的值是：${r.output.trim().slice(0, 100) || '（空）'}` };
  },
});

const registryDelete = defineTool<{ path: string; name?: string }>({
  name: 'registry_delete', group: 'admin', riskLevel: 'high', requiresConfirmation: true,
  description: '删除注册表值（给 name）或整个键（不给 name）。删除前自动导出备份。每次确认。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 500 }, name: { type: 'string', maxLength: 200 } }, required: ['path'] },
  title: (a) => `删除注册表 ${a.path}${a.name ? `\\${a.name}` : '（整个键）'}`,
  assess: (a) => {
    const p = normalizeRegPath(a.path);
    return { risk: 'high', reason: `${a.name ? '' : '⚠ 会删除整个键及其所有子键。'}删除前会自动备份。${p?.hive === 'HKCU' ? '' : UAC_NOTE}`, preview: [`删除：${p?.reg ?? a.path}${a.name ? ` → 值 ${a.name}` : '（整个键）'}`] };
  },
  execute: async (a, ctx) => {
    const p = normalizeRegPath(a.path);
    if (!p) return { ok: false, summary: '路径不合法', error: '注册表路径要以 HKLM\\ / HKCU\\ 等开头' };
    if (!a.name && p.reg.split('\\').length < 3) return { ok: false, summary: '拒绝删除', error: '不能删除这么靠近根部的注册表键' };
    const backup = path.join(ctx.services.journal.backupDir, `reg-${Date.now()}.reg`);
    const r = await ps(ctx, `
New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $in.backup) | Out-Null
reg.exe export $in.reg $in.backup /y | Out-Null
if ($in.n) { Remove-ItemProperty -LiteralPath $in.p -Name $in.n } else { Remove-Item -LiteralPath $in.p -Recurse }
"已删除；备份：$($in.backup)"`, { p: p.ps, reg: p.reg, n: a.name ?? null, backup }, p.hive !== 'HKCU', 2 * MIN);
    const res = shellResult(r, '已删除');
    return { ...res, data: { ...(res.data ?? {}), backup } };
  },
});

export const adminTools: AnyTool[] = [runAdminCommand, wingetSearch, listInstalled, installSoftware, uninstallSoftware, upgradeSoftware, manageService, registryRead, registryWrite, registryDelete];

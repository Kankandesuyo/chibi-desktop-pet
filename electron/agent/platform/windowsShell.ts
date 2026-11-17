import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { InstalledApp, RunningApp, UiElementInfo, UiElementQuery, UiTarget, UiWindowInfo, ShellResult } from '../types';

/**
 * Windows automation through PowerShell. User/model input is NEVER spliced into script text:
 * it travels as JSON in an environment variable and the script reads it with ConvertFrom-Json.
 */
export async function runPowerShell<T>(script: string, input: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  const prelude = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $in = $env:PET_AGENT_INPUT | ConvertFrom-Json;\n";
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  return new Promise<T>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { ...process.env, PET_AGENT_INPUT: JSON.stringify(input) }, windowsHide: true,
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PowerShell 超时')); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(err.trim().split('\n').slice(0, 3).join(' ') || `PowerShell 退出码 ${code}`)); return; }
      const text = out.trim();
      if (!text) { resolve(null as T); return; }
      try { resolve(JSON.parse(text) as T); } catch { resolve(text as T); }
    });
  });
}

const asArray = <T>(v: T | T[] | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export async function listRunningApps(): Promise<RunningApp[]> {
  const rows = await runPowerShell<RunningApp | RunningApp[]>(`
$r = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  $p = $null; try { $p = $_.Path } catch {}
  [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle; path = $p } }
ConvertTo-Json -InputObject @($r) -Compress -Depth 3`, {});
  return asArray(rows);
}

export async function findInstalledApps(query: string): Promise<InstalledApp[]> {
  const rows = await runPowerShell<(InstalledApp & { exe?: string }) | (InstalledApp & { exe?: string })[]>(`
$q = ([string]$in.query).ToLower()
$sh = New-Object -ComObject WScript.Shell
$res = New-Object System.Collections.ArrayList
foreach ($d in @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {
  if (-not $d) { continue }
  Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.BaseName.ToLower().Contains($q) } | ForEach-Object {
    $t = ''; try { $t = $sh.CreateShortcut($_.FullName).TargetPath } catch {}
    [void]$res.Add([pscustomobject]@{ name = $_.BaseName; target = $_.FullName; exe = $t; kind = 'shortcut' }) } }
try { Get-StartApps | Where-Object { $_.Name.ToLower().Contains($q) } | ForEach-Object {
  [void]$res.Add([pscustomobject]@{ name = $_.Name; target = ('shell:AppsFolder\\' + $_.AppID); exe = ''; kind = 'store-app' }) } } catch {}
foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName.ToLower().Contains($q) } | ForEach-Object {
    $v = (Get-ItemProperty -LiteralPath $_.PSPath).'(default)'
    if ($v) { $v = $v.Trim('"'); [void]$res.Add([pscustomobject]@{ name = $_.PSChildName; target = $v; exe = $v; kind = 'exe' }) } } }
ConvertTo-Json -InputObject @($res | Select-Object -First 25) -Compress -Depth 3`, { query }, 45_000);
  const seen = new Set<string>();
  return asArray(rows).filter((r) => { const k = `${r.name}|${r.target}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function isProcessRunning(sel: { pid?: number; name?: string }): Promise<boolean> {
  if (sel.pid) { try { process.kill(sel.pid, 0); return true; } catch { return false; } }
  if (!sel.name) return false;
  const n = await runPowerShell<number>('@(Get-Process -Name $in.name -ErrorAction SilentlyContinue).Count', { name: sel.name });
  return Number(n) > 0;
}

const USER32 = `
if (-not ('PetW' -as [type])) { Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class PetW {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
}
"@ }
function Focus-Handle($h) { if ([PetW]::IsIconic($h)) { [void][PetW]::ShowWindow($h, 9) }; [void][PetW]::SetForegroundWindow($h) }
`;

export async function focusApp(sel: { pid?: number; title?: string }): Promise<boolean> {
  const r = await runPowerShell<boolean>(`${USER32}
$p = $null
if ($in.pid) { $p = Get-Process -Id $in.pid -ErrorAction SilentlyContinue }
elseif ($in.title) { $t = ([string]$in.title).ToLower(); $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.ToLower().Contains($t) } | Select-Object -First 1 }
if (-not $p -or $p.MainWindowHandle -eq 0) { 'false'; exit }
try { [void](New-Object -ComObject WScript.Shell).AppActivate($p.Id) } catch {}
Focus-Handle $p.MainWindowHandle
Start-Sleep -Milliseconds 300
([PetW]::GetForegroundWindow() -eq $p.MainWindowHandle) | ConvertTo-Json`, sel);
  return r === true;
}

/** Processes the agent may never close. */
const NEVER_CLOSE = new Set(['explorer', 'csrss', 'winlogon', 'lsass', 'services', 'svchost', 'dwm', 'smss', 'wininit', 'system', 'registry', 'fontdrvhost', 'sihost', 'ctfmon', 'msmpeng', 'securityhealthservice']);

export async function closeApp(sel: { pid?: number; name?: string }, force: boolean, selfPid: number): Promise<number> {
  if (sel.pid === selfPid) throw new Error('不能关闭桌宠自己');
  if (sel.name !== undefined && !/^[\w .()-]{1,80}$/.test(sel.name)) throw new Error('程序名不合法');
  const name = sel.name?.replace(/\.exe$/i, '');
  if (name && NEVER_CLOSE.has(name.toLowerCase())) throw new Error(`${name} 是系统进程，不能关闭`);
  const n = await runPowerShell<number>(`
$ps = if ($in.pid) { @(Get-Process -Id $in.pid -ErrorAction SilentlyContinue) } else { @(Get-Process -Name $in.name -ErrorAction SilentlyContinue) }
$n = 0
foreach ($p in $ps) {
  if ($p.Id -eq $in.self) { continue }
  if ($in.force) { Stop-Process -Id $p.Id -Force; $n++ } elseif ($p.MainWindowHandle -ne 0 -and $p.CloseMainWindow()) { $n++ } }
$n`, { pid: sel.pid ?? null, name: name ?? null, force, self: selfPid });
  return Number(n) || 0;
}

// ---------------------------------------------------------------- UI Automation ----

const UIA = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
${USER32}
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TC = [System.Windows.Automation.Condition]::TrueCondition
function Find-Win($t) {
  foreach ($w in $AE::RootElement.FindAll($TS::Children, $TC)) {
    $c = $w.Current
    if ($t.pid -and $c.ProcessId -eq $t.pid) { return $w }
    if ($t.window -and $c.Name -and $c.Name.ToLower().Contains(([string]$t.window).ToLower())) { return $w } }
  return $null }
function Short($ct) { return ($ct.ProgrammaticName -replace '^ControlType\\.', '') }
function Find-El($win, $q) {
  $hits = New-Object System.Collections.ArrayList
  foreach ($e in $win.FindAll($TS::Descendants, $TC)) {
    $c = $e.Current
    if ($q.automationId -and $c.AutomationId -ne $q.automationId) { continue }
    if ($q.name -and -not ($c.Name -and $c.Name.ToLower().Contains(([string]$q.name).ToLower()))) { continue }
    if ($q.controlType -and (Short $c.ControlType) -ne $q.controlType) { continue }
    [void]$hits.Add($e)
    if ($hits.Count -gt 50) { break } }
  $i = 0; if ($q.index) { $i = [int]$q.index }
  if ($hits.Count -le $i) { return $null }
  return $hits[$i] }
function Pat($e, $p) { $o = $null; if ($e.TryGetCurrentPattern($p, [ref]$o)) { return $o }; return $null }
`;

export async function uiListWindows(): Promise<UiWindowInfo[]> {
  return asArray(await runPowerShell<UiWindowInfo | UiWindowInfo[]>(`${UIA}
$r = foreach ($w in $AE::RootElement.FindAll($TS::Children, $TC)) { $c = $w.Current; if (-not $c.Name) { continue }
  $pn = ''; try { $pn = (Get-Process -Id $c.ProcessId).ProcessName } catch {}
  [pscustomobject]@{ title = $c.Name; pid = $c.ProcessId; processName = $pn; handle = $c.NativeWindowHandle } }
ConvertTo-Json -InputObject @($r) -Compress`, {}));
}

export async function uiActiveWindow(): Promise<UiWindowInfo | null> {
  return runPowerShell<UiWindowInfo | null>(`${USER32}
$h = [PetW]::GetForegroundWindow(); if ($h -eq [IntPtr]::Zero) { 'null'; exit }
$sb = New-Object System.Text.StringBuilder 512; [void][PetW]::GetWindowText($h, $sb, 512)
$pid2 = [uint32]0; [void][PetW]::GetWindowThreadProcessId($h, [ref]$pid2)
$pn = ''; try { $pn = (Get-Process -Id $pid2).ProcessName } catch {}
[pscustomobject]@{ title = $sb.ToString(); pid = [int]$pid2; processName = $pn; handle = [int64]$h } | ConvertTo-Json -Compress`, {});
}

export async function uiInspect(target: UiTarget, opts: { maxCount: number; nameContains?: string }): Promise<UiElementInfo[]> {
  return asArray(await runPowerShell<UiElementInfo | UiElementInfo[]>(`${UIA}
$w = Find-Win $in.target; if (-not $w) { throw '找不到指定窗口' }
$f = ''; if ($in.nameContains) { $f = ([string]$in.nameContains).ToLower() }
$r = New-Object System.Collections.ArrayList
foreach ($e in $w.FindAll($TS::Descendants, $TC)) {
  $c = $e.Current
  if ($f -and -not ($c.Name -and $c.Name.ToLower().Contains($f))) { continue }
  if (-not $c.Name -and -not $c.AutomationId) { continue }
  $pats = @($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers\\.Pattern$', '' })
  [void]$r.Add([pscustomobject]@{ name = $c.Name; controlType = (Short $c.ControlType); automationId = $c.AutomationId; enabled = $c.IsEnabled; patterns = $pats })
  if ($r.Count -ge $in.maxCount) { break } }
ConvertTo-Json -InputObject @($r) -Compress -Depth 3`, { target: target as Record<string, unknown>, ...opts }, 45_000));
}

export async function uiClick(target: UiTarget, el: UiElementQuery, allowMouse: boolean): Promise<string> {
  return runPowerShell<string>(`${UIA}
$w = Find-Win $in.target; if (-not $w) { throw '找不到指定窗口' }
$e = Find-El $w $in.el; if (-not $e) { throw '找不到指定控件，请先用 inspect_ui_elements 查看控件' }
if (-not $e.Current.IsEnabled) { throw '控件当前不可用（灰色）' }
$p = Pat $e ([System.Windows.Automation.InvokePattern]::Pattern); if ($p) { $p.Invoke(); 'invoked'; exit }
$p = Pat $e ([System.Windows.Automation.TogglePattern]::Pattern); if ($p) { $p.Toggle(); 'toggled'; exit }
$p = Pat $e ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($p) { $p.Select(); 'selected'; exit }
$p = Pat $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($p) { $p.Expand(); 'expanded'; exit }
if (-not $in.allowMouse) { throw '这个控件不支持无障碍点击；如确需用鼠标点击它的位置，请设置 allowMouseFallback=true（高风险）' }
Focus-Handle ([IntPtr]$w.Current.NativeWindowHandle)
$b = $e.Current.BoundingRectangle; [void][PetW]::SetCursorPos([int]($b.X + $b.Width / 2), [int]($b.Y + $b.Height / 2))
[PetW]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); [PetW]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); 'mouse-clicked'`, { target: target as Record<string, unknown>, el: el as Record<string, unknown>, allowMouse });
}

export async function uiType(target: UiTarget, el: UiElementQuery | null, text: string): Promise<string> {
  return runPowerShell<string>(`${UIA}
$w = Find-Win $in.target; if (-not $w) { throw '找不到指定窗口' }
if ($in.el) {
  $e = Find-El $w $in.el; if (-not $e) { throw '找不到指定控件' }
  $v = Pat $e ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($v -and -not $v.Current.IsReadOnly) { $v.SetValue([string]$in.text); 'value-set'; exit }
  $e.SetFocus()
} else { Focus-Handle ([IntPtr]$w.Current.NativeWindowHandle) }
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait([string]$in.keys); 'typed'`, { target: target as Record<string, unknown>, el: el as Record<string, unknown> | null, text, keys: escapeSendKeys(text) });
}

export async function uiHotkey(target: UiTarget | null, keys: string): Promise<string> {
  return runPowerShell<string>(`${UIA}
if ($in.target) { $w = Find-Win $in.target; if (-not $w) { throw '找不到指定窗口' }; Focus-Handle ([IntPtr]$w.Current.NativeWindowHandle); Start-Sleep -Milliseconds 200 }
[System.Windows.Forms.SendKeys]::SendWait([string]$in.keys); 'sent'`, { target: target as Record<string, unknown> | null, keys: toSendKeys(keys) });
}

export async function uiScroll(target: UiTarget, el: UiElementQuery | null, direction: 'up' | 'down', amount: number): Promise<string> {
  return runPowerShell<string>(`${UIA}
$w = Find-Win $in.target; if (-not $w) { throw '找不到指定窗口' }
$sp = [System.Windows.Automation.ScrollPattern]::Pattern
$e = $null
if ($in.el) { $e = Find-El $w $in.el } else { foreach ($x in $w.FindAll($TS::Descendants, $TC)) { if (Pat $x $sp) { $e = $x; break } } }
if (-not $e) { throw '找不到可以滚动的控件' }
$s = Pat $e $sp; if (-not $s) { throw '这个控件不能滚动' }
$amt = if ($in.direction -eq 'up') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
for ($i = 0; $i -lt $in.amount; $i++) { $s.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $amt) }
'scrolled'`, { target: target as Record<string, unknown>, el: el as Record<string, unknown> | null, direction, amount });
}

// ---------------------------------------------------------------- pure helpers (tested) ----

/** Escapes text so SendKeys types it literally. */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}').replace(/\t/g, '{TAB}');
}

const KEY_NAMES: Record<string, string> = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ', backspace: '{BS}',
  delete: '{DEL}', del: '{DEL}', insert: '{INS}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pgup: '{PGUP}',
  pagedown: '{PGDN}', pgdn: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
};

/** "ctrl+shift+s" -> "^+s", "alt+f4" -> "%{F4}". Throws on keys SendKeys cannot send (e.g. the Windows key). */
export function toSendKeys(combo: string): string {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('快捷键为空');
  let mods = '';
  const key = parts.pop() as string;
  for (const m of parts) {
    if (m === 'ctrl' || m === 'control') mods += '^';
    else if (m === 'shift') mods += '+';
    else if (m === 'alt') mods += '%';
    else if (m === 'win' || m === 'windows' || m === 'meta') throw new Error('不支持 Win 键组合');
    else throw new Error(`不认识的修饰键：${m}`);
  }
  let k: string;
  if (KEY_NAMES[key] !== undefined) k = KEY_NAMES[key] as string;
  else if (/^f([1-9]|1[0-6])$/.test(key)) k = `{${key.toUpperCase()}}`;
  else if (key.length === 1) k = escapeSendKeys(key);
  else throw new Error(`不认识的按键：${key}`);
  return mods + k;
}

// ---------------------------------------------------------------- scripts & elevation ----


const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Runs one of our scripts without elevation; output (stdout + errors) comes back as text. */
export async function runScript(script: string, input: Record<string, unknown>, timeoutMs: number): Promise<ShellResult> {
  try {
    const r = await runPowerShell<{ ok: boolean; output: string }>(`
try { $o = & { ${script} } 2>&1 | Out-String -Width 300; @{ ok = $true; output = $o } | ConvertTo-Json -Compress }
catch { @{ ok = $false; output = $_.Exception.Message } | ConvertTo-Json -Compress }`, input, timeoutMs);
    return { ok: Boolean(r?.ok), output: String(r?.output ?? '').trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs one of our scripts as administrator: Windows shows its UAC prompt every time.
 * The input is embedded as base64 (cannot break out of the string); the result comes back through a temp file
 * because an elevated process's output cannot be piped to a non-elevated parent.
 */
export async function runElevated(script: string, input: Record<string, unknown>, timeoutMs: number): Promise<ShellResult> {
  const outFile = path.join(os.tmpdir(), `chibipet-elev-${randomUUID()}.json`);
  const b64 = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  const secs = Math.max(5, Math.round(timeoutMs / 1000) - 5);
  const inner = `$ErrorActionPreference='Stop'
$in = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json
$res = $null
try {
  $j = Start-Job -ArgumentList $in -ScriptBlock { param($in) $ErrorActionPreference='Stop'; & { ${script} } 2>&1 | Out-String -Width 300 }
  if (Wait-Job $j -Timeout ${secs}) {
    $o = Receive-Job $j -ErrorVariable jerr 2>&1 | Out-String -Width 300
    $res = @{ ok = ($j.State -eq 'Completed' -and -not $jerr); output = ($o + ($jerr | Out-String)) }
  } else { Stop-Job $j; $res = @{ ok = $false; output = '超时，已停止' } }
} catch { $res = @{ ok = $false; output = $_.Exception.Message } }
$res | ConvertTo-Json -Compress | Set-Content -LiteralPath ${psQuote(outFile)} -Encoding UTF8`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  try {
    const status = await runPowerShell<string>(`
try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand', $in.inner) }
catch { 'CANCELLED'; exit }
$p.WaitForExit(); 'DONE'`, { inner: encoded }, timeoutMs + 60_000);
    if (status === 'CANCELLED') return { ok: false, cancelled: true, output: '你在 Windows 的“用户账户控制”窗口里取消了，没有执行' };
    const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '') : '';
    if (!raw) return { ok: false, output: '管理员进程没有返回结果' };
    const r = JSON.parse(raw) as { ok?: boolean; output?: string };
    return { ok: Boolean(r.ok), output: String(r.output ?? '').trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

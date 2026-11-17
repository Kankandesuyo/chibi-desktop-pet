'use strict';
const path = require('node:path');
const { captureWindowImage } = require('./capture-window.cjs');
const { systemKey: checkedSystemKey } = require('./tools.cjs');

// Static native code, with data passed through runPowerShell's JSON environment
// variable. Neither the model nor the user can supply PowerShell/C# source.
const NATIVE = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PetComputer {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor,rcWork; public uint flags; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public IntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public IntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h,StringBuilder s,int length);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,int attr,out int value,int size);
 [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] public static extern int DwmGetWindowBounds(IntPtr h,int attr,out RECT value,int size);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,StringBuilder s,int length);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flag);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr h,ref MONITORINFO m);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n,INPUT[] values,int size);
 public static bool Owned(IntPtr current,IntPtr target) {
   for(int i=0;i<12 && current!=IntPtr.Zero;i++) { if(current==target)return true; current=GetWindow(current,4); } return false;
 }
 public static void Guard(IntPtr h) { if(!IsWindow(h) || !Owned(GetForegroundWindow(),h)) throw new Exception("目标窗口不在前台，已停止输入"); }
 public static void PointGuard(IntPtr h,int x,int y) {
   Guard(h); POINT p=new POINT(); p.X=x;p.Y=y;
   if(!Owned(GetAncestor(WindowFromPoint(p),2),h)) throw new Exception("点击位置被其他窗口遮挡，已停止");
 }
 public static void Send(INPUT input) {
   if(SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("Windows 拒绝输入（可能是 UAC 或权限等级不同），没有尝试绕过");
 }
 public static INPUT MousePacket(uint flags,int wheel) { INPUT i=new INPUT();i.type=0;i.u.mouse.dwFlags=flags;i.u.mouse.mouseData=unchecked((uint)wheel);return i; }
 public static void Mouse(uint flags,int wheel) { Send(MousePacket(flags,wheel)); }
 public static void Key(ushort key,bool up) { INPUT i=new INPUT();i.type=1;i.u.key.vk=key;i.u.key.flags=up?2u:0u;Send(i); }
 public static void Text(IntPtr h,string text) {
   foreach(char c in text) { Guard(h); INPUT i=new INPUT();i.type=1;i.u.key.scan=c;i.u.key.flags=4;Send(i);i.u.key.flags=6;Send(i); }
 }
}
"@
[void][PetComputer]::SetThreadDpiAwarenessContext([IntPtr](-4))
$h=[IntPtr]([int64]$in.handle)
if(-not [PetComputer]::IsWindow($h)) { throw '目标窗口已关闭' }
$procId=[uint32]0;[void][PetComputer]::GetWindowThreadProcessId($h,[ref]$procId)
if($in.pid -and $procId -ne $in.pid) { throw '窗口归属已改变' }
$proc=Get-Process -Id $procId -ErrorAction Stop
$born=$proc.StartTime.ToUniversalTime().Ticks.ToString()
if($in.born -and $born -ne $in.born) { throw '目标进程已重启，旧观察不可用' }
if($in.focus) {
 if([PetComputer]::IsIconic($h)) { [void][PetComputer]::ShowWindowAsync($h,9) }
 try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$procId) } catch {}
 [void][PetComputer]::SetForegroundWindow($h)
 Start-Sleep -Milliseconds 500
 [PetComputer]::Guard($h)
}
if(-not [PetComputer]::IsWindowVisible($h) -or [PetComputer]::IsIconic($h)) { throw '目标窗口隐藏或仍最小化，不能观察和输入' }
$cloaked=0
if([PetComputer]::DwmGetWindowAttribute($h,14,[ref]$cloaked,4) -eq 0 -and $cloaked -ne 0) { throw '目标窗口被系统隐藏（可能在其他虚拟桌面），没有输入' }
$rect=New-Object PetComputer+RECT
if(-not [PetComputer]::GetWindowRect($h,[ref]$rect)) { throw '无法读取窗口坐标' }
$visualRect=New-Object PetComputer+RECT
if([PetComputer]::DwmGetWindowBounds($h,9,[ref]$visualRect,16) -eq 0 -and $visualRect.Right -gt $visualRect.Left -and $visualRect.Bottom -gt $visualRect.Top){$rect=$visualRect}
$monitor=New-Object PetComputer+MONITORINFO;$monitor.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($monitor)
if(-not [PetComputer]::GetMonitorInfo([PetComputer]::MonitorFromWindow($h,2),[ref]$monitor)) { throw '无法读取屏幕信息' }
$title=New-Object Text.StringBuilder 512;[void][PetComputer]::GetWindowText($h,$title,512)
$client=New-Object PetComputer+RECT;$origin=New-Object PetComputer+POINT
if(-not [PetComputer]::GetClientRect($h,[ref]$client) -or -not [PetComputer]::ClientToScreen($h,[ref]$origin)){throw '无法读取窗口内容边界'}
if($in.action) {
 [PetComputer]::Guard($h)
 if($in.x -lt $rect.Left -or $in.x -ge $rect.Right -or $in.y -lt $rect.Top -or $in.y -ge $rect.Bottom) { throw '操作位置已不在目标窗口内' }
 # Recheck geometry in the same process immediately before native input.
 if($rect.Left -ne $in.left -or $rect.Top -ne $in.top -or $rect.Right -ne $in.right -or $rect.Bottom -ne $in.bottom) { throw '窗口位置发生变化，必须重新观察' }
 [PetComputer]::PointGuard($h,[int]$in.x,[int]$in.y)
 [void][PetComputer]::SetCursorPos([int]$in.x,[int]$in.y)
 if($in.action -eq 'scroll') {
  Start-Sleep -Milliseconds 120
  [PetComputer]::PointGuard($h,[int]$in.x,[int]$in.y)
  $wheelFlag=if($in.horizontal){0x1000}else{0x800}
  [PetComputer]::Mouse($wheelFlag, [int]$in.wheel)
 }
 elseif($in.action -eq 'drag') {
  [PetComputer]::Mouse(2,0)
  try { for($j=1;$j -le 10;$j++) { [PetComputer]::Guard($h);[void][PetComputer]::SetCursorPos([int]($in.x+($in.toX-$in.x)*$j/10),[int]($in.y+($in.toY-$in.y)*$j/10));Start-Sleep -Milliseconds 20 } }
  finally { [PetComputer]::Mouse(4,0) }
 }
 else {
  if($in.action -eq 'right_click') { [PetComputer]::Mouse(8,0);[PetComputer]::Mouse(16,0) }
  else {
   [PetComputer]::Mouse(2,0);[PetComputer]::Mouse(4,0)
   if($in.action -eq 'double_click') { Start-Sleep -Milliseconds 80;[PetComputer]::PointGuard($h,[int]$in.x,[int]$in.y);[PetComputer]::Mouse(2,0);[PetComputer]::Mouse(4,0) }
   if($in.action -eq 'type') { [PetComputer]::Text($h,[string]$in.text) }
   if($in.action -eq 'key') {
    $pressed=New-Object System.Collections.ArrayList
    try { foreach($code in $in.codes) { [PetComputer]::Guard($h);[PetComputer]::Key([uint16]$code,$false);[void]$pressed.Add($code) } }
    finally { for($j=$pressed.Count-1;$j -ge 0;$j--) { [PetComputer]::Key([uint16]$pressed[$j],$true) } }
   }
  }
 }
}
[pscustomobject]@{handle=[int64]$h;pid=[int]$procId;born=$born;title=$title.ToString();processName=$proc.ProcessName;left=$rect.Left;top=$rect.Top;right=$rect.Right;bottom=$rect.Bottom;client=@{left=$origin.X;top=$origin.Y;right=$origin.X+$client.Right;bottom=$origin.Y+$client.Bottom};monitor=@{left=$monitor.rcMonitor.Left;top=$monitor.rcMonitor.Top;right=$monitor.rcMonitor.Right;bottom=$monitor.rcMonitor.Bottom;primary=(($monitor.flags -band 1) -eq 1)};foreground=[PetComputer]::Owned([PetComputer]::GetForegroundWindow(),$h)} | ConvertTo-Json -Depth 4 -Compress
`;

const SYSTEM_KEY = NATIVE.slice(0, NATIVE.indexOf('$h=[IntPtr]')) + `
function Active-Meta {
 $fg=[PetComputer]::GetForegroundWindow();$id=[uint32]0
 [void][PetComputer]::GetWindowThreadProcessId($fg,[ref]$id)
 $name='';try{$name=(Get-Process -Id $id -ErrorAction Stop).ProcessName}catch{}
 $class=New-Object Text.StringBuilder 256;[void][PetComputer]::GetClassName($fg,$class,256)
 [pscustomobject]@{handle=[int64]$fg;pid=[int]$id;processName=$name;className=$class.ToString();desktop=($fg -eq [PetComputer]::GetShellWindow() -or $class.ToString() -in @('Progman','WorkerW'))}
}
function Is-Expected($meta) {
 if($in.keys -eq 'win') { return $meta.processName -in @('StartMenuExperienceHost','ShellExperienceHost','SearchHost','SearchApp') }
 if($in.keys -eq 'win+e') { return $meta.processName -eq 'explorer' -and $meta.className -eq 'CabinetWClass' }
 if($in.keys -eq 'win+d') { return $meta.desktop }
 return $false
}
if($in.keys -notin @('win','win+e','win+d')) { throw '不支持的系统按键' }
$before=Active-Meta
if($before.handle -eq 0 -or $before.processName -eq 'consent'){throw '当前是安全提示或不可操作桌面，没有发送系统按键'}
$already=Is-Expected $before
if(-not $already) {
 $pressed=New-Object System.Collections.ArrayList
 try {
  [PetComputer]::Key(91,$false);[void]$pressed.Add(91)
  if($in.keys -ne 'win') { $code=if($in.keys -eq 'win+e'){69}else{68};[PetComputer]::Key([uint16]$code,$false);[void]$pressed.Add($code) }
 } finally { for($j=$pressed.Count-1;$j -ge 0;$j--){[PetComputer]::Key([uint16]$pressed[$j],$true)} }
}
$after=Active-Meta
for($i=0;$i -lt 20 -and -not (Is-Expected $after);$i++){Start-Sleep -Milliseconds 100;$after=Active-Meta}
$verified=Is-Expected $after
$detail=if($verified){switch($in.keys){'win'{'开始或系统搜索界面已在前台'}'win+e'{'文件资源管理器已在前台'}'win+d'{'桌面已在前台'}}}else{'未检测到预期系统窗口，不重复按键'}
[pscustomobject]@{executed=(-not $already);verified=$verified;detail=$detail;foreground=$after} | ConvertTo-Json -Depth 4 -Compress
`;

function createWindowsBackend({ app, platform, electron, allowedSelfHandles = () => [] }) {
  const { runPowerShell } = require(path.join(app.getAppPath(), 'dist-electron/electron/agent/platform/windowsShell.js'));
  const query = (target, focus) => runPowerShell(NATIVE, { handle: target.handle, pid: target.pid, born: target.born, focus }, 15000);
  async function select(args) {
    const rows = await platform.ui.listWindows();
    const matches = rows.filter(w => (!args.pid || w.pid === args.pid) && (!args.window || w.title?.toLowerCase().includes(args.window.toLowerCase())) && (!args.handle || String(w.handle) === args.handle));
    if (matches.length !== 1) throw new Error(`匹配到 ${matches.length} 个窗口，请用 list_windows 查清后同时指定 pid 和 handle`);
    if (matches[0].pid === process.pid && !allowedSelfHandles().includes(String(matches[0].handle))) throw new Error('不能操作桌宠自己的聊天、设置或授权窗口');
    return matches[0];
  }
  async function capture(target, focus, signal) {
    signal?.throwIfAborted();
    const meta = await query(target, focus); signal?.throwIfAborted();
    if (!meta.monitor.primary) throw new Error('此版本只操作主屏幕上的窗口，请先把目标窗口移到主屏幕');
    if (!meta.foreground) throw new Error('目标窗口不在前台，不能可靠观察；请手动点到前台后重试');
    const m = meta.monitor;
    const rect = { left: Math.max(m.left, meta.left), top: Math.max(m.top, meta.top), right: Math.min(m.right, meta.right), bottom: Math.min(m.bottom, meta.bottom) };
    const fullArea = (meta.right - meta.left) * (meta.bottom - meta.top), area = (rect.right - rect.left) * (rect.bottom - rect.top);
    if (area < fullArea * .9 || area < 10000) throw new Error('窗口超出主屏幕或太小，请把窗口完整移到屏幕内再观察');
    // Window thumbnails represent the complete window, so partial clipping is
    // rejected rather than mapping a full-window image onto a clipped rectangle.
    if (area !== fullArea) throw new Error('请将目标窗口完整移入主屏幕，再进行窗口采集');
    let fixture = null;
    if (meta.pid === process.pid && allowedSelfHandles().includes(String(meta.handle))) {
      const { pathToFileURL } = require('node:url');
      const urls = ['computer-use.html','input-regression.html'].map(file => pathToFileURL(path.join(__dirname, '../tests', file)).href);
      fixture = electron.BrowserWindow.getAllWindows().find(win => {
        const h = win.getNativeWindowHandle();
        return String(h.length >= 8 ? Number(h.readBigUInt64LE()) : h.readUInt32LE()) === String(meta.handle) && urls.includes(win.webContents.getURL());
      });
    }
    const captured = await captureWindowImage(meta, electron, signal, fixture), image = captured.image;
    const latest = await query(meta, false); signal?.throwIfAborted();
    if (!latest.foreground || ['handle','pid','born','left','top','right','bottom'].some(k => latest[k] !== meta[k])) throw new Error('采集过程中目标窗口或前台已变化，请重新观察');
    return { meta, rect: captured.contentOnly ? meta.client : rect, image, png: image.toPNG(), size: image.getSize() };
  }
  async function act(frame, point, args, signal) {
    signal?.throwIfAborted();
    return runPowerShell(NATIVE, { ...frame.meta, focus: false, action: args.action, x: point.x, y: point.y, toX: args.to?.x, toY: args.to?.y, text: args.text, codes: args.codes, wheel: args.wheel, horizontal: args.horizontal }, 15000);
  }
  async function systemKey(keys, signal) {
    signal?.throwIfAborted();
    return runPowerShell(SYSTEM_KEY, { keys: checkedSystemKey(keys) }, 15000);
  }
  return { select, capture, act, systemKey };
}
module.exports = { createWindowsBackend, NATIVE, SYSTEM_KEY };



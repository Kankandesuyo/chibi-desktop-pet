import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import type { UpdateStatus } from '../shared/types';

/**
 * In-app update: a new build is staged as resources/app.asar.new (next to the running app.asar).
 * The main window shows "有新版本" and applying it hands the file swap to a small hidden PowerShell
 * that waits until every process of this exe has exited (they keep app.asar open), moves the new
 * file over the old one and starts the app again. Only in the packaged app.
 */
const MIN_SIZE = 1_000_000;  // a real app.asar is ~30 MB; anything tiny is a broken copy

function stagedFile(): string { return path.join(process.resourcesPath, 'app.asar.new'); }

export function updateStatus(): UpdateStatus {
  if (!app.isPackaged) return { ready: false };
  try {
    const st = fs.statSync(stagedFile());
    if (st.size < MIN_SIZE) return { ready: false, error: '更新文件不完整' };
    return { ready: true, stagedAt: st.mtimeMs };
  } catch { return { ready: false }; }
}

function psQuote(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

/** Starts the detached swap-and-restart helper, then quits. */
function applyUpdate(quit: () => void): { ok: boolean; error?: string } {
  const status = updateStatus();
  if (!status.ready) return { ok: false, error: status.error ?? '没有可安装的更新' };
  const exe = process.execPath;
  const asar = path.join(process.resourcesPath, 'app.asar');
  const log = path.join(os.tmpdir(), 'chibi-pet-update.log');
  // Same command-line switches as this run (e.g. --user-data-dir), minus debugger ports.
  const args = process.argv.slice(1).filter((x) => !/^--(inspect|remote-debugging)/.test(x));
  const script = [
    `$exe = ${psQuote(exe)}; $new = ${psQuote(stagedFile())}; $asar = ${psQuote(asar)}; $log = ${psQuote(log)}`,
    'function Log($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + " " + $m) -Encoding UTF8 }',
    'Log "start"',
    // Wait (up to 30 s) for every process of this exe to go away; they hold app.asar open.
    '$deadline = (Get-Date).AddSeconds(30)',
    'while ((Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }',
    'Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue',
    '$moved = $false',
    'for ($i = 0; $i -lt 20 -and -not $moved; $i++) { try { Move-Item -LiteralPath $new -Destination $asar -Force -ErrorAction Stop; $moved = $true } catch { Log ("move failed: " + $_.Exception.Message); Start-Sleep -Milliseconds 500 } }',
    'Log ("moved=" + $moved)',
    // Start it again either way: the old version is better than no pet.
    args.length
      ? `Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -ArgumentList @(${args.map((x) => psQuote(x.includes(' ') ? `"${x}"` : x)).join(', ')})`
      : 'Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)',
    'Log "restarted"',
  ].join('\n');
  try {
    // A plain (even detached) child is killed together with the app when it quits; one started through
    // `cmd /c start` is not (checked on Windows 11), so the helper outlives us.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('cmd.exe', ['/d', '/c', `start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}`], {
      detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
    });
    child.unref();
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  setTimeout(quit, 200);
  return { ok: true };
}

/**
 * Watches for a staged update and tells the windows (`evt:update`); `onChange` lets the tray rebuild its menu.
 * Returns the apply function for the tray.
 */
export function registerUpdater(broadcast: (channel: string, payload: unknown) => void, quit: () => void, onChange: () => void): () => void {
  let last = JSON.stringify(updateStatus());
  const check = (): void => {
    const now = JSON.stringify(updateStatus());
    if (now === last) return;
    last = now;
    broadcast('evt:update', updateStatus());
    onChange();
  };
  const timer = setInterval(check, 5_000);
  app.on('will-quit', () => clearInterval(timer));
  ipcMain.handle('app:update-status', () => updateStatus());
  ipcMain.handle('app:update-apply', () => applyUpdate(quit));
  return () => { applyUpdate(quit); };
}

'use strict';
// Local native regression: opens Start, verifies its shell identity, and only
// dismisses the exact menu this test opened. Never types text or submits data.
const fs = require('node:fs');
const path = require('node:path');
const { SYSTEM_KEY, NATIVE } = require('../computer-use/windows.cjs');
const { runPowerShell } = require('../app-source/dist-electron/electron/agent/platform/windowsShell.js');
(async () => {
  const result = await runPowerShell(SYSTEM_KEY, { keys: 'win' }, 15000);
  let dismissed = null;
  if (result.executed && result.verified) {
    dismissed = await runPowerShell(NATIVE.slice(0, NATIVE.indexOf('$h=[IntPtr]')) + `
$h=[IntPtr]([int64]$in.handle);$id=[uint32]0
[void][PetComputer]::GetWindowThreadProcessId($h,[ref]$id)
if([PetComputer]::GetForegroundWindow() -ne $h -or $id -ne $in.pid){'false';exit}
$name=(Get-Process -Id $id -ErrorAction Stop).ProcessName
if($name -notin @('StartMenuExperienceHost','ShellExperienceHost','SearchHost','SearchApp')){'false';exit}
[PetComputer]::Guard($h)
try{[PetComputer]::Key(27,$false)}finally{[PetComputer]::Key(27,$true)}
'true'`, { handle: result.foreground.handle, pid: result.foreground.pid }, 10000);
  }
  const report = { ...result, dismissed };
  fs.writeFileSync(path.join(__dirname, '../outputs/win-key-regression.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!result.verified) process.exitCode = 1;
})().catch(err => { console.error(err.message); process.exitCode = 1; });


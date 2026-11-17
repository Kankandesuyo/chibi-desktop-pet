'use strict';
// Invoked only by the explicit local --pet-input-regression flag. Native input
// targets this exact synthetic fixture; no model, accounts or network involved.
const fs = require('node:fs');
const path = require('node:path');
const { NATIVE } = require('../computer-use/windows.cjs');
async function runInputRegression({ demo, backend, electron, app }) {
  const expected = new URL('file://' + path.join(__dirname, 'input-regression.html').replace(/\\/g, '/')).href;
  if (decodeURI(demo.webContents.getURL()) !== decodeURI(expected)) throw new Error('Only the dedicated local fixture can run this regression');
  const handleBuffer = demo.getNativeWindowHandle();
  const handle = String(handleBuffer.length >= 8 ? Number(handleBuffer.readBigUInt64LE()) : handleBuffer.readUInt32LE());
  const signal = AbortSignal.timeout(55000);
  const target = { handle, pid: process.pid };
  const sources = await electron.desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 200, height: 150 } });
  const sourceProbe = { handle, totalWindowSources: sources.length, fixtureSources: sources.filter(s => s.name.includes('桌宠电脑操作测试')).map(s => ({ id: s.id, size: s.thumbnail.getSize(), empty: s.thumbnail.isEmpty() })) };
  const position = () => demo.webContents.executeJavaScript(`(()=>{const e=document.querySelector('#scrollbox'),r=e.getBoundingClientRect();return {left:e.scrollLeft,top:e.scrollTop,x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const initial = await position();
  const scroll = async (wheel, horizontal) => {
    let frame;
    try { frame = await backend.capture(target, true, signal); }
    catch (err) { throw new Error(err.message + '\nSynthetic source diagnostic: ' + JSON.stringify(sourceProbe)); }
    const p = await position();
    const scale = electron.screen.getPrimaryDisplay().scaleFactor;
    await backend.act(frame, { x: Math.round(frame.meta.client.left + p.x * scale), y: Math.round(frame.meta.client.top + p.y * scale) }, { action: 'scroll', wheel, horizontal }, signal);
    await new Promise(resolve => setTimeout(resolve, 250));
    return position();
  };
  const vertical = await scroll(-360, false);
  if (!(vertical.top > initial.top)) throw new Error('Native vertical scroll did not move the synthetic region');
  const horizontal = await scroll(360, true);
  if (!(horizontal.left > vertical.left)) throw new Error('Native horizontal scroll did not move the synthetic region');
  const frame = await backend.capture(target, true, signal);
  fs.writeFileSync(path.join(__dirname, '../previews/input-scroll-result.png'), frame.png);
  // Open Start through the same native backend used by the confirmed tool.
  // If this test opened it, dismiss only that exact foreground shell handle.
  const start = await backend.systemKey('win', signal);
  let dismissed = null;
  if (start.executed && start.verified && ['StartMenuExperienceHost', 'ShellExperienceHost', 'SearchHost', 'SearchApp'].includes(start.foreground.processName)) {
    const { runPowerShell } = require(path.join(app.getAppPath(), 'dist-electron/electron/agent/platform/windowsShell.js'));
    dismissed = await runPowerShell(NATIVE.slice(0, NATIVE.indexOf('$h=[IntPtr]')) + `
$h=[IntPtr]([int64]$in.handle);$procId=[uint32]0
[void][PetComputer]::GetWindowThreadProcessId($h,[ref]$procId)
if([PetComputer]::GetForegroundWindow() -ne $h -or $procId -ne $in.pid){'false';exit}
$name=(Get-Process -Id $procId -ErrorAction Stop).ProcessName
if($name -notin @('StartMenuExperienceHost','ShellExperienceHost','SearchHost','SearchApp')){'false';exit}
[PetComputer]::Guard($h)
try{[PetComputer]::Key(27,$false)}finally{[PetComputer]::Key(27,$true)}
'true'`, { handle: start.foreground.handle, pid: start.foreground.pid }, 10000);
  }
  return { ok: start.verified === true, initial, vertical, horizontal, windowCapture: true, start, dismissed };
}
module.exports = { runInputRegression };


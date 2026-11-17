'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureWindowImage } = require('./computer-use/capture-window.cjs');
const meta = { handle: 12, left: 0, top: 0, right: 800, bottom: 600 };
function image(w = 800, h = 600) { return { isEmpty: () => false, getSize: () => ({ width: w, height: h }), resize: () => image(1440, 1080) }; }
test('capture selects HWND exactly and requests no desktop sources', async () => {
  const selected = image();
  const electron = { desktopCapturer: { getSources: async options => {
    assert.deepEqual(options.types, ['window']);
    return [{ id: 'screen:12:0', name: '微信', thumbnail: image() }, { id: 'window:123:0', name: '微信', thumbnail: image() }, { id: 'window:12:0', name: '微信', thumbnail: selected }];
  } } };
  assert.equal((await captureWindowImage(meta, electron)).image, selected);
});
test('missing or empty target capture fails without falling back to desktop or a same-title window', async () => {
  for (const rows of [[{ id: 'window:13:0', name: '微信', thumbnail: image() }], [{ id: 'window:12:0', thumbnail: { isEmpty: () => true } }]]) {
    await assert.rejects(captureWindowImage(meta, { desktopCapturer: { getSources: async () => rows } }), /未改用桌面截图/);
  }
});
test('bad aspect ratio and cancelled capture cannot yield coordinates', async () => {
  await assert.rejects(captureWindowImage(meta, { desktopCapturer: { getSources: async () => [{ id: 'window:12:0', thumbnail: image(900, 100) }] } }), /尺寸/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(captureWindowImage(meta, {} , abort.signal));
});
test('only an explicitly supplied local fixture uses content capture when Electron omits own windows', async () => {
  const selected = image();
  const result = await captureWindowImage(meta, { desktopCapturer: { getSources: async () => [] } }, undefined, { webContents: { capturePage: async () => selected } });
  assert.equal(result.image, selected); assert.equal(result.contentOnly, true);
});
test('Windows native backend compiles and encodes signed wheel deltas correctly without sending input', { skip: process.platform !== 'win32' }, async () => {
  const { NATIVE } = require('./computer-use/windows.cjs');
  const { runPowerShell } = require('../dist-electron/electron/agent/platform/windowsShell.js');
  const result = await runPowerShell(NATIVE.slice(0, NATIVE.indexOf('$h=[IntPtr]')) + `
$packet=[PetComputer]::MousePacket(0x800,-120)
$horizontal=[PetComputer]::MousePacket(0x1000,240)
[pscustomobject]@{size=[Runtime.InteropServices.Marshal]::SizeOf($packet);wheel=[int64]$packet.u.mouse.mouseData;horizontal=$horizontal.u.mouse.dwFlags;amount=$horizontal.u.mouse.mouseData} | ConvertTo-Json -Compress`, {}, 20000);
  assert.equal(result.size, process.arch === 'x64' ? 40 : 28);
  assert.equal(result.wheel, 4294967176); assert.equal(result.horizontal, 0x1000); assert.equal(result.amount, 240);
});
test('PowerShell executes the real Win modifier press/release branches with SendInput replaced by a recorder', { skip: process.platform !== 'win32' }, async () => {
  const { SYSTEM_KEY } = require('./computer-use/windows.cjs');
  const { runPowerShell } = require('../dist-electron/electron/agent/platform/windowsShell.js');
  let script = SYSTEM_KEY.replace('public class PetComputer {', 'public class PetComputer { public static System.Collections.Generic.List<INPUT> Sent = new System.Collections.Generic.List<INPUT>();');
  const send = 'if(SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("Windows 拒绝输入（可能是 UAC 或权限等级不同），没有尝试绕过");';
  assert.ok(script.includes(send));
  script = script.replace(send, 'Sent.Add(input);')
    .replace('$already=Is-Expected $before', '$already=$false')
    .replace('$i -lt 20 -and', '$i -lt 0 -and');
  script = script.slice(0, script.indexOf('[pscustomobject]@{executed=')) + '[pscustomobject]@{codes=@([PetComputer]::Sent | ForEach-Object {$_.u.key.vk});flags=@([PetComputer]::Sent | ForEach-Object {$_.u.key.flags})} | ConvertTo-Json -Compress';
  const result = await runPowerShell(script, { keys: 'win+e' }, 20000);
  assert.deepEqual(result.codes, [91, 69, 69, 91]);
  assert.deepEqual(result.flags, [0, 0, 2, 2]);
});

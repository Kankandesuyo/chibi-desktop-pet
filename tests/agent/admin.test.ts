import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dangerReasons, normalizeRegPath } from '../../electron/agent/tools/adminTools';
import { call, finalSteps, lastToolResult, makeHarness, say, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(() => { h?.cleanup(); h = undefined; });

describe('administrator commands', () => {
  it('ask every time (no "allow for task"), run elevated, and warn about dangerous commands', async () => {
    h = makeHarness([
      call('run_admin_command', { command: 'powercfg /change standby-timeout-ac 0' }),
      call('run_admin_command', { command: 'Set-MpPreference -DisableRealtimeMonitoring $true' }),
      say('好了'),
    ]);
    h.platform.shellAnswers.push({ match: /Invoke-Expression/, result: { ok: true, output: 'done' } });
    const r = await h.run('关掉睡眠，再关掉实时防护', { decide: () => 'allow_task' });
    expect(r.confirms).toHaveLength(2);
    expect(r.confirms.every((c) => c.risk === 'high' && !c.canAllowForTask)).toBe(true);
    expect(r.confirms[0]?.preview.join('\n')).toContain('powercfg /change standby-timeout-ac 0');
    expect(r.confirms[0]?.reason).toContain('UAC');
    expect(r.confirms[1]?.reason).toContain('Windows Defender');
    expect(h.platform.scripts.map((s) => s.elevated)).toEqual([true, true]);
    // the command reaches the script as data, never as part of the script text
    expect(h.platform.scripts[0]?.script).not.toContain('powercfg');
    expect(h.platform.scripts[0]?.input.command).toBe('powercfg /change standby-timeout-ac 0');
  });

  it('reports a cancelled UAC prompt as not done', async () => {
    h = makeHarness([call('run_admin_command', { command: 'ipconfig /flushdns' }), (m) => { expect(lastToolResult(m).ok).toBe(false); return say('你取消了'); }]);
    h.platform.shellAnswers.push({ match: /Invoke-Expression/, result: { ok: false, cancelled: true, output: '你在 Windows 的“用户账户控制”窗口里取消了，没有执行' } });
    const r = await h.run('刷新 DNS');
    expect(finalSteps(r)[0]?.status).toBe('failed');
    expect(r.done?.outcome).toBe('failure');
  });

  it('nothing runs if the user says no in the chat', async () => {
    h = makeHarness([call('run_admin_command', { command: 'shutdown /s /t 0' }), say('没执行')]);
    const r = await h.run('关机', { decide: () => 'deny' });
    expect(r.confirms[0]?.reason).toContain('关机');
    expect(h.platform.scripts).toHaveLength(0);
  });
});

describe('software (winget)', () => {
  it('searches without asking, installs elevated with confirmation, and verifies via winget list', async () => {
    h = makeHarness([
      call('winget_search', { query: 'vscode' }),
      call('install_software', { id: 'Microsoft.VisualStudioCode' }),
      (m) => { expect(lastToolResult(m)).toMatchObject({ ok: true, verified: true }); return say('装好了'); },
    ]);
    h.platform.shellAnswers.push(
      { match: /winget search/, result: { ok: true, output: 'Microsoft Visual Studio Code  Microsoft.VisualStudioCode  1.95' } },
      { match: /winget list --id/, result: { ok: true, output: 'Microsoft Visual Studio Code Microsoft.VisualStudioCode 1.95' } },
      { match: /"install"/, result: { ok: true, output: 'Successfully installed' } },
    );
    const r = await h.run('帮我装 VS Code');
    expect(r.confirms).toHaveLength(1);
    expect(h.platform.scripts.map((s) => [s.script.includes('install') ? 'install' : s.script.includes('search') ? 'search' : 'list', s.elevated]))
      .toEqual([['search', false], ['install', true], ['list', false]]);
  });

  it('rejects package ids that could smuggle extra arguments', async () => {
    h = makeHarness([call('install_software', { id: 'foo --override "/S /D=C:\\x"' }), say('不行')]);
    const r = await h.run('装');
    expect(finalSteps(r)[0]?.status).toBe('failed');
    expect(h.platform.scripts).toHaveLength(0);
  });
});

describe('services', () => {
  it('status needs no confirmation; stopping a critical service is high risk with a warning', async () => {
    h = makeHarness([call('manage_service', { name: 'Spooler', action: 'status' }), call('manage_service', { name: 'WinDefend', action: 'stop' }), say('ok')]);
    h.platform.shellAnswers.push({ match: /"\$\(\$s.Status\)/, result: { ok: true, output: 'Stopped|Automatic' } });
    const r = await h.run('看看打印服务，再停掉 Defender');
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]?.reason).toContain('关键服务');
    expect(h.platform.scripts.map((s) => s.elevated)).toEqual([false, true, false]);
    expect(finalSteps(r).at(-1)?.verified).toBe(true);
  });
});

describe('registry', () => {
  it('normalises paths and spots dangerous commands', () => {
    expect(normalizeRegPath('HKEY_LOCAL_MACHINE\\SOFTWARE\\X')).toEqual({ ps: 'Registry::HKLM\\SOFTWARE\\X', reg: 'HKLM\\SOFTWARE\\X', hive: 'HKLM' });
    expect(normalizeRegPath('hkcu:\\Software\\Y\\')).toMatchObject({ reg: 'HKCU\\Software\\Y' });
    expect(normalizeRegPath('C:\\Windows')).toBeNull();
    expect(dangerReasons('format D: /q')).toContain('格式化或修改磁盘分区');
    expect(dangerReasons('Get-ChildItem')).toEqual([]);
  });

  it('HKCU writes run without elevation, HKLM writes elevate; both back up first and verify by reading back', async () => {
    h = makeHarness([
      call('registry_write', { path: 'HKCU\\Software\\Pet', name: 'Mood', value: 'happy' }),
      call('registry_write', { path: 'HKLM\\SOFTWARE\\Pet', name: 'Level', value: '3', type: 'DWord' }),
      say('ok'),
    ]);
    h.platform.shellAnswers.push({ match: /-join/, result: { ok: true, output: 'happy' } }, { match: /New-ItemProperty/, result: { ok: true, output: '已写入' } });
    const r = await h.run('写注册表');
    expect(r.confirms).toHaveLength(2);
    const writes = h.platform.scripts.filter((s) => s.script.includes('New-ItemProperty'));
    expect(writes.map((s) => s.elevated)).toEqual([false, true]);
    expect(String(writes[0]?.input.backup)).toContain('backups');
    expect(finalSteps(r).map((s) => s.verified)).toEqual([true, false]);       // fake returns "happy" for both reads
  });
});

describe('full disk access', () => {
  it('reaches other drives; system folders are allowed but high risk; the pet\'s own data stays off-limits', async () => {
    h = makeHarness([], { settings: { fullDiskAccess: true } });
    const d = path.join(h.platform.drive, 'D', '项目');
    const sys = path.join(h.platform.folders.home, 'Windows', 'tmp-test');
    const own = path.join(h.baseDir, 'evil');
    h.llm.push(call('create_directory', { path: d }), call('create_directory', { path: sys }), call('create_directory', { path: own }), say('ok'));
    const r = await h.run('建几个文件夹', { decide: () => 'allow_task' });
    expect(fs.existsSync(d)).toBe(true);
    expect(fs.existsSync(sys)).toBe(true);
    expect(fs.existsSync(own)).toBe(false);
    expect(r.confirms.map((c) => c.risk)).toEqual(['medium', 'high']);
    expect(r.confirms[1]?.reason).toContain('系统文件夹');
    expect(finalSteps(r)[2]?.status).toBe('denied');
  });

  it('without it, system folders stay protected', async () => {
    h = makeHarness([call('create_directory', { path: path.join('~', 'Windows', 'x') }), say('no')]);
    h.settings.allowedRoots = [h.platform.folders.home];
    const r = await h.run('建文件夹');
    expect(finalSteps(r)[0]?.status).toBe('denied');
  });

  it('the admin tools disappear when the group is switched off', async () => {
    h = makeHarness([say('hi')]);
    h.settings.toolGroups.admin = false;
    h.rt.applyGroups();
    await h.run('hi');
    expect(h.llm.requests[0]?.tools?.some((t) => t.function.name === 'run_admin_command')).toBe(false);
  });
});

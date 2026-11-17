import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, desktopCapturer, screen, shell } from 'electron';
import type { DesktopPlatform, KnownFolders, UiAutomation } from '../types';
import { splitArgs } from './splitArgs';
import * as win from './windowsShell';

const IS_WIN = process.platform === 'win32';
const unsupported = (what: string): Error => new Error(`${what}目前只支持 Windows（当前系统：${process.platform}）`);

/** The real platform: Electron + Node for portable bits, PowerShell/UI Automation for Windows-only ones. */
export function createElectronPlatform(): DesktopPlatform {
  const ui: UiAutomation = IS_WIN
    ? {
        activeWindow: () => win.uiActiveWindow(),
        listWindows: () => win.uiListWindows(),
        inspect: (t, o) => win.uiInspect(t, o),
        click: (t, e) => win.uiClick(t, e, false),
        typeText: (t, e, text) => win.uiType(t, e, text),
        hotkey: (t, k) => win.uiHotkey(t, k),
        scroll: (t, e, d, n) => win.uiScroll(t, e, d, n),
        waitForWindow: async (title, timeoutMs) => {
          const end = Date.now() + timeoutMs;
          const needle = title.toLowerCase();
          while (Date.now() < end) {
            const hit = (await win.uiListWindows()).find((w) => w.title.toLowerCase().includes(needle));
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 600));
          }
          return null;
        },
      }
    : {
        activeWindow: () => Promise.reject(unsupported('窗口信息')),
        listWindows: () => Promise.reject(unsupported('窗口列表')),
        inspect: () => Promise.reject(unsupported('界面控件识别')),
        click: () => Promise.reject(unsupported('界面点击')),
        typeText: () => Promise.reject(unsupported('输入文字')),
        hotkey: () => Promise.reject(unsupported('快捷键')),
        scroll: () => Promise.reject(unsupported('滚动')),
        waitForWindow: () => Promise.reject(unsupported('等待窗口')),
      };

  return {
    os: process.platform,
    knownFolders(): KnownFolders {
      const g = (n: Parameters<typeof app.getPath>[0]): string => { try { return app.getPath(n); } catch { return app.getPath('home'); } };
      const windir = process.env.SystemRoot ?? 'C:\\Windows';
      return {
        home: g('home'), desktop: g('desktop'), documents: g('documents'), downloads: g('downloads'),
        pictures: g('pictures'), music: g('music'), videos: g('videos'), temp: g('temp'),
        protected: [g('userData'), app.getAppPath(), path.dirname(process.execPath)],
        system: [
          windir,
          process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          process.env.ProgramData ?? 'C:\\ProgramData',
          path.join(g('home'), '.ssh'), path.join(g('appData'), 'Microsoft'),
        ],
      };
    },
    selfLaunch() {
      // Packaged: the exe itself. Development: electron.exe + the app folder.
      return app.isPackaged
        ? { target: process.execPath, args: '', icon: process.execPath }
        : { target: process.execPath, args: `"${app.getAppPath()}"`, icon: path.join(app.getAppPath(), 'build', 'icon.png') };
    },
    openPath: (p) => shell.openPath(p),
    openUrl: (url) => shell.openExternal(url),
    trash: (p) => shell.trashItem(p),
    async createShortcut(lnk, o) {
      if (!IS_WIN) return false;
      return shell.writeShortcutLink(lnk, 'create', { target: o.target, args: o.args, cwd: o.cwd, description: o.description, icon: o.icon && fs.existsSync(o.icon) ? o.icon : undefined, iconIndex: 0 });
    },
    listRunningApps: () => (IS_WIN ? win.listRunningApps() : Promise.reject(unsupported('程序列表'))),
    findInstalledApps: (q) => (IS_WIN ? win.findInstalledApps(q) : Promise.reject(unsupported('查找已安装程序'))),
    async launch({ target, args, cwd }) {
      if (!IS_WIN) throw unsupported('启动程序');
      if (target.toLowerCase().startsWith('shell:appsfolder\\')) {
        if (args?.length) throw new Error('应用商店应用不支持启动参数');
        spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
        return {};
      }
      let exe = target; let finalArgs = args ?? [];
      if (target.toLowerCase().endsWith('.lnk')) {
        if (!fs.existsSync(target)) throw new Error(`快捷方式不存在：${target}`);
        if (!finalArgs.length) { const err = await shell.openPath(target); if (err) throw new Error(err); return {}; }
        const link = shell.readShortcutLink(target);
        exe = link.target;
        finalArgs = [...splitArgs(link.args ?? ''), ...finalArgs];
        cwd = cwd ?? link.cwd;
      }
      if (!fs.existsSync(exe)) throw new Error(`程序不存在：${exe}，请先用 find_installed_app 查找`);
      if (fs.statSync(exe).isDirectory()) throw new Error('这是文件夹，请用 open_path 打开');
      const child = spawn(exe, finalArgs, { cwd: cwd && fs.existsSync(cwd) ? cwd : path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
      await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
      child.unref();
      return { pid: child.pid };
    },
    focus: (sel) => (IS_WIN ? win.focusApp(sel) : Promise.reject(unsupported('切换窗口'))),
    close: (sel, force) => (IS_WIN ? win.closeApp(sel, force, process.pid) : Promise.reject(unsupported('关闭程序'))),
    isRunning: (sel) => (IS_WIN ? win.isProcessRunning(sel) : Promise.resolve(false)),
    ui,
    drives() {
      if (!IS_WIN) return ['/'];
      const out: string[] = [];
      for (let c = 65; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; try { if (fs.existsSync(d)) out.push(d); } catch { /* not ready */ } }
      return out;
    },
    powershell: (script, input, opts) => (IS_WIN
      ? (opts.elevated ? win.runElevated(script, input, opts.timeoutMs) : win.runScript(script, input, opts.timeoutMs))
      : Promise.resolve({ ok: false, output: `系统级操作目前只支持 Windows（当前系统：${process.platform}）` })),
    async captureScreen() {
      const d = screen.getPrimaryDisplay();
      const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
      if (!src || src.thumbnail.isEmpty()) throw new Error('截图失败（系统可能没有授予屏幕录制权限）');
      return src.thumbnail.toPNG();
    },
  };
}

export { win as windowsShell };

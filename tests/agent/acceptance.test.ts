/**
 * The 12 acceptance tests from the upgrade spec. The "computer" is a temp folder plus a fake app layer
 * (see helpers.ts); the "model" follows a script, so every assertion is about what the agent machinery
 * does with the model's decisions: permissions, execution, verification and reporting.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, calls, finalSteps, lastToolResult, makeHarness, say, type Harness } from './helpers';

let h: Harness;
afterEach(() => h?.cleanup());

describe('1. 创建桌宠自己的桌面快捷方式', () => {
  it('uses create_shortcut with @pet, asks once (medium), and verifies the .lnk exists', async () => {
    h = makeHarness([
      call('create_shortcut', { target: '@pet', name: 'Chibi Desktop Pet' }, '我来帮你放～'),
      (m) => { expect(lastToolResult(m)).toMatchObject({ ok: true, verified: true }); return say('放好啦！[[emotion:happy|action:wave]]'); },
    ]);
    const r = await h.run('帮我把你的快捷方式放到桌面');
    const lnk = path.join(h.platform.folders.desktop, 'Chibi Desktop Pet.lnk');
    expect(fs.existsSync(lnk)).toBe(true);
    expect(h.platform.shortcuts[0]?.target).toContain('Chibi Desktop Pet.exe');
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]?.risk).toBe('medium');
    expect(r.done?.outcome).toBe('success');
    // The interim text ("我来帮你放～") is never presented as the result.
    expect(r.events.find((e) => e.type === 'interim')).toBeDefined();
    expect(r.done?.reply).toBe('放好啦！');
  });
});

describe('2. 创建指定桌面文件夹', () => {
  it('looks up the real desktop path, creates the folder and verifies it', async () => {
    h = makeHarness([
      call('get_known_folders', {}),
      (m) => call('create_directory', { path: path.join((lastToolResult(m).data as { desktop: string }).desktop, 'AI项目') }),
      (m) => { expect(lastToolResult(m).verified).toBe(true); return say('建好啦'); },
    ]);
    const r = await h.run('帮我创建一个叫 AI项目 的文件夹');
    expect(fs.statSync(path.join(h.platform.folders.desktop, 'AI项目')).isDirectory()).toBe(true);
    expect(r.done?.outcome).toBe('success');
    expect(finalSteps(r).map((s) => s.status)).toEqual(['ok', 'ok']);
  });
});

describe('3. 搜索指定文件', () => {
  it("finds yesterday's PDF in Downloads and nothing else", async () => {
    h = makeHarness();
    const dl = h.platform.folders.downloads;
    const day = 86_400_000;
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const mk = (name: string, t: number): void => { const p = path.join(dl, name); fs.writeFileSync(p, 'x'); fs.utimesSync(p, t / 1000, t / 1000); };
    mk('昨天的报告.pdf', startToday - day / 2);
    mk('上周的报告.pdf', startToday - 7 * day);
    mk('昨天的图片.png', startToday - day / 2);
    fs.mkdirSync(path.join(dl, 'sub')); mk(path.join('sub', '子目录里的.pdf'), startToday - day / 3);
    h.llm.push(
      call('search_files', { root: dl, extensions: ['.pdf'], modifiedAfter: new Date(startToday - day).toISOString(), modifiedBefore: new Date(startToday).toISOString() }),
      (m) => {
        const data = lastToolResult(m).data as { results: { path: string }[] };
        expect(data.results.map((x) => path.basename(x.path)).sort()).toEqual(['子目录里的.pdf', '昨天的报告.pdf'].sort());
        return say('找到两个');
      },
    );
    const r = await h.run('帮我找到昨天下载的 PDF');
    expect(r.done?.outcome).toBe('success');
  });
});

describe('4. 启动指定应用', () => {
  it('finds VS Code, launches it without asking (known app, low risk) and verifies the window appeared', async () => {
    h = makeHarness([
      call('find_installed_app', { query: 'Visual Studio Code' }),
      (m) => call('launch_application', { target: ((lastToolResult(m).data as { target: string }[])[0] as { target: string }).target }),
      (m) => { expect(lastToolResult(m)).toMatchObject({ ok: true, verified: true }); return say('打开啦！'); },
    ]);
    const r = await h.run('打开 VS Code');
    expect(h.platform.launched).toHaveLength(1);
    expect(r.confirms).toHaveLength(0);
    expect(r.done?.outcome).toBe('success');
    // The pet "worked" before it reported success.
    const phases = r.pet.map((p) => p.agent);
    expect(phases.indexOf('working')).toBeLessThan(phases.lastIndexOf('success'));
  });

  it('asks before launching with arguments (e.g. opening a project folder)', async () => {
    h = makeHarness([
      call('find_installed_app', { query: 'code' }),
      (m) => call('launch_application', { target: ((lastToolResult(m).data as { target: string }[])[0] as { target: string }).target, args: ['D:\\proj'] }),
      say('好了'),
    ]);
    const r = await h.run('用 VS Code 打开我的项目');
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]?.preview.join('\n')).toContain('D:\\proj');
  });
});

describe('5. 打开指定网址', () => {
  it('opens http(s) only', async () => {
    h = makeHarness([
      call('open_url', { url: 'example.com/news' }),
      call('open_url', { url: 'javascript:alert(1)' }),
      call('open_url', { url: 'file:///C:/Windows/system32/calc.exe' }),
      say('打开了第一个'),
    ]);
    const r = await h.run('打开 example.com/news');
    expect(h.platform.urls).toEqual(['https://example.com/news']);
    expect(finalSteps(r).map((s) => s.status)).toEqual(['ok', 'failed', 'failed']);
  });
});

describe('6. 多步骤文件整理', () => {
  it('plans, previews, asks once, moves by type, verifies every file and counts', async () => {
    h = makeHarness();
    const d = h.platform.folders.desktop;
    for (const f of ['a.png', 'b.jpg', 'c.pdf', 'note.txt']) fs.writeFileSync(path.join(d, f), f);
    fs.writeFileSync(path.join(h.platform.folders.pictures, 'a.png'), 'already there');   // name clash -> auto-rename
    const pics = h.platform.folders.pictures; const docs = h.platform.folders.documents;
    h.llm.push(
      call('update_plan', { steps: [{ title: '扫描桌面', status: 'in_progress' }, { title: '按类型移动', status: 'pending' }, { title: '汇报', status: 'pending' }] }),
      call('list_directory', { path: d }),
      (m) => {
        const items = (lastToolResult(m).data as { items: { name: string; ext: string }[] }).items;
        const moves = items.filter((i) => ['.png', '.jpg', '.pdf'].includes(i.ext))
          .map((i) => ({ from: path.join(d, i.name), toFolder: i.ext === '.pdf' ? docs : pics }));
        return call('move_files', { moves });
      },
      (m) => {
        const r = lastToolResult(m);
        expect(r).toMatchObject({ ok: true, verified: true });
        expect((r.data as { moved: number }).moved).toBe(3);
        return call('update_plan', { steps: [{ title: '扫描桌面', status: 'done' }, { title: '按类型移动', status: 'done' }, { title: '汇报', status: 'done' }] });
      },
      say('整理好了，一共移动了 3 个文件。'),
    );
    const r = await h.run('帮我整理桌面，把图片放到图片文件夹，PDF 放到文档文件夹，最后告诉我整理了多少个文件');
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]?.preview.join('\n')).toMatch(/Pictures（2 项）/);
    expect(fs.readdirSync(d)).toEqual(['note.txt']);
    expect(fs.readdirSync(pics).sort()).toEqual(['a (2).png', 'a.png', 'b.jpg']);
    expect(fs.existsSync(path.join(docs, 'c.pdf'))).toBe(true);
    expect(r.events.some((e) => e.type === 'plan')).toBe(true);
    expect(r.pet.some((p) => p.progress?.total === 3)).toBe(true);
    expect(r.done?.outcome).toBe('success');

    // …and the whole thing can be undone.
    h.llm.push(call('undo_file_operations', { scope: 'last_task' }), say('撤销了'));
    await h.run('撤销刚才的整理');
    expect(fs.readdirSync(d).sort()).toEqual(['a.png', 'b.jpg', 'c.pdf', 'note.txt']);
    expect(fs.readFileSync(path.join(pics, 'a.png'), 'utf8')).toBe('already there');
  });
});

describe('7. 工具失败时正确提示', () => {
  it('reports the failure to the model and the user; outcome is failure, never success', async () => {
    h = makeHarness([
      call('move_file', { from: path.join('~', 'Desktop', '不存在.txt'), to: path.join('~', 'Documents') }),
      (m) => { expect(lastToolResult(m)).toMatchObject({ ok: false }); expect(String(lastToolResult(m).error)).toContain('不存在'); return say('没找到这个文件，没能移动。'); },
    ]);
    h.settings.autoApproveMedium = true;
    const r = await h.run('把桌面的 不存在.txt 移到文档');
    expect(finalSteps(r)[0]?.status).toBe('failed');
    expect(r.done?.outcome).toBe('failure');
    expect(r.pet.map((p) => p.agent)).toContain('failure');
    expect(r.done?.emotion).not.toBe('happy');
  });
});

describe('8. 没有权限时停止执行', () => {
  it('refuses paths outside the allowed folders without asking, and protected folders even inside them', async () => {
    h = makeHarness();
    const outside = path.join(h.platform.root, 'outside', 'x');
    const appData = path.join(h.platform.folders.home, 'AppData', 'evil');
    h.settings.allowedRoots = [h.platform.folders.home];   // even if the whole home is allowed…
    h.llm.push(call('create_directory', { path: outside }), call('create_directory', { path: appData }), say('没有权限'));
    const r = await h.run('在外面建个文件夹');
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(appData)).toBe(false);
    expect(r.confirms).toHaveLength(0);
    expect(finalSteps(r).map((s) => s.status)).toEqual(['denied', 'denied']);
    expect(finalSteps(r)[1]?.summary).toContain('受保护');
  });

  it('stops when the user says no', async () => {
    h = makeHarness([call('create_directory', { path: path.join('~', 'Desktop', 'X') }), (m) => { expect(lastToolResult(m).status).toBe('denied'); return say('好的，不建了'); }]);
    const r = await h.run('建个文件夹 X', { decide: () => 'deny' });
    expect(fs.existsSync(path.join(h.platform.folders.desktop, 'X'))).toBe(false);
    expect(finalSteps(r)[0]?.status).toBe('denied');
  });

  it('cannot move or delete an allowed root itself', async () => {
    h = makeHarness([call('delete_file', { path: '~/Desktop' }), say('不行')]);
    const r = await h.run('删掉桌面');
    expect(fs.existsSync(h.platform.folders.desktop)).toBe(true);
    expect(r.confirms).toHaveLength(0);
    expect(finalSteps(r)[0]?.status).toBe('denied');
  });
});

describe('9. API 请求失败时桌宠仍能正常运行', () => {
  it('turns the failure into an error event and the next request works', async () => {
    h = makeHarness([new Error('接口返回 500：server down'), say('我回来啦')]);
    const r1 = await h.run('你好');
    expect(r1.error).toContain('500');
    expect(r1.pet.at(-1)?.agent).toBe('failure');
    const r2 = await h.run('你好');
    expect(r2.done?.reply).toBe('我回来啦');
    expect(r2.done?.outcome).toBe('chat');
    expect(h.rt.logger.recentTasks().map((t) => t.status)).toEqual(['chat', 'failure']);
  });
});

describe('10. 未注册工具不能绕过注册表执行', () => {
  it('rejects invented tools, disabled groups and malformed arguments', async () => {
    h = makeHarness([
      calls(['shell_exec', { cmd: 'rm -rf /' }], ['run_command', { command: 'echo hi', cwd: '~/Desktop' }], ['create_directory', { path: '~/Desktop/a', extra: 1 }]),
      (m) => { expect(String(lastToolResult(m).error)).toContain('不认识的参数'); return say('做不到'); },
    ]);
    h.settings.toolGroups.dev = false;
    h.rt.applyGroups();
    const r = await h.run('执行命令');
    expect(finalSteps(r).map((s) => s.status)).toEqual(['failed', 'failed', 'failed']);
    expect(r.confirms).toHaveLength(0);
    expect(fs.existsSync(path.join(h.platform.folders.desktop, 'a'))).toBe(false);
    // Disabled tools are not even offered to the model.
    expect(h.llm.requests[0]?.tools?.some((t) => t.function.name === 'run_command')).toBe(false);
  });
});

describe('11. 高风险操作必须等待用户确认', () => {
  it('does nothing while waiting, and "allow for this task" does not carry over for high risk', async () => {
    h = makeHarness();
    const f1 = path.join(h.platform.folders.desktop, 'old.txt'); fs.writeFileSync(f1, '1');
    const f2 = path.join(h.platform.folders.desktop, 'old2.txt'); fs.writeFileSync(f2, '2');
    h.llm.push(call('delete_file', { path: f1 }), call('delete_file', { path: f2 }), say('删好了'));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let seenWhileWaiting: boolean | null = null;
    const running = h.run('删掉这两个', {
      decide: async (req) => {
        if (req.title.includes('old.txt')) { seenWhileWaiting = fs.existsSync(f1); await gate; }
        expect(req.risk).toBe('high');
        expect(req.canAllowForTask).toBe(false);
        return 'allow_task' as const;
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(f1)).toBe(true);           // still waiting -> nothing happened
    release();
    const r = await running;
    expect(seenWhileWaiting).toBe(true);
    expect(r.confirms).toHaveLength(2);              // asked again for the second file
    expect(fs.existsSync(f1) || fs.existsSync(f2)).toBe(false);
  });

  it('times out to "no" when nobody answers', async () => {
    h = makeHarness([call('delete_file', { path: '~/Desktop/keep.txt' }), say('没删')]);
    fs.writeFileSync(path.join(h.platform.folders.desktop, 'keep.txt'), 'x');
    h.rt.permissions.confirmTimeoutMs = 150;
    const r = await h.run('删掉 keep.txt', { decide: () => new Promise(() => undefined) });
    expect(fs.existsSync(path.join(h.platform.folders.desktop, 'keep.txt'))).toBe(true);
    expect(finalSteps(r)[0]?.summary).toContain('超时');
  });

  it('medium risk: "allow for this task" stops the repeat questions within the task only', async () => {
    h = makeHarness([call('create_directory', { path: '~/Desktop/a' }), call('create_directory', { path: '~/Desktop/b' }), say('ok')]);
    const r = await h.run('建两个文件夹', { decide: () => 'allow_task' });
    expect(r.confirms).toHaveLength(1);
    h.llm.push(call('create_directory', { path: '~/Desktop/c' }), say('ok'));
    const r2 = await h.run('再建一个');
    expect(r2.confirms).toHaveLength(1);
  });
});

describe('12. 应用重启后仍能读取偏好和任务记录', () => {
  it('keeps memories, the task list and the audit log (with secrets redacted)', async () => {
    h = makeHarness([call('remember', { text: '常用编辑器是 VS Code', category: '常用软件' }), say('记住啦')], { secrets: ['sk-supersecretkey1234567890'] });
    await h.run('记住我常用 VS Code，我的 key 是 sk-supersecretkey1234567890');
    const { baseDir, platform } = h;
    void h.rt.shutdown();

    const h2 = makeHarness([], { baseDir, platform });
    expect(h2.rt.memory.list().map((m) => m.text)).toEqual(['常用编辑器是 VS Code']);
    expect(h2.rt.logger.recentTasks()[0]?.status).toBe('success');
    const log = fs.readdirSync(h2.rt.logger.logDir).map((f) => fs.readFileSync(path.join(h2.rt.logger.logDir, f), 'utf8')).join('');
    expect(log).toContain('remember');
    expect(log).not.toContain('sk-supersecretkey1234567890');
    // Memory reaches the prompt as context, labelled as not being permission.
    h2.llm.push(say('好'));
    await h2.run('你好');
    const sys = String(h2.llm.requests[0]?.messages[0]?.content);
    expect(sys).toContain('常用编辑器是 VS Code');
    expect(sys).toContain('不是授权');
    h = h2;
  });
});

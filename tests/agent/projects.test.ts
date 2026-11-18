/**
 * Conversations: pin / delete; project folders (Codex / Claude Code style workspace) and edit_file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../electron/agent/SessionStore';
import { call, FakePlatform, finalSteps, lastToolResult, makeHarness, say, type Harness } from './helpers';

let h: Harness | undefined;
let platform: FakePlatform | undefined;
afterEach(() => { h?.cleanup(); h = undefined; platform?.cleanup(); platform = undefined; });

describe('SessionStore: pin, delete, project', () => {
  const make = (): SessionStore => { platform = new FakePlatform(); return new SessionStore(path.join(platform.root, 'sessions')); };

  it('reuses an untouched draft from history and shows one per project', () => {
    const s = make();
    const original = s.id;
    expect(s.openDraft()).toBe(original);
    s.addChat({ id: 'msg', role: 'user', content: '新会话' });
    const unused = s.openDraft();
    const other = s.newSession(); // a duplicate created by an older version
    expect(s.list().map(x => x.id).sort()).toEqual([original, other].sort());
    s.switchTo(original);
    const draft = s.openDraft();
    expect([unused, other]).toContain(draft);
    expect(s.openDraft()).toBe(draft);
    expect(new SessionStore(s.dir).openDraft()).toBe(draft);
    const folder = platform!.folders.documents;
    const project = s.openDraft(folder);
    s.setProject(folder);
    expect(s.openDraft(folder)).toBe(project);
    expect(s.openDraft()).toBe(draft);
    expect(s.switchTo(original)).toBe(true);
    expect(s.chat()[0]?.content).toBe('新会话');
  });

  it('pins and remembers it across a restart', () => {
    const s = make();
    const a = s.id;
    s.addChat({ id: '第一个', role: 'user', content: '第一个' });
    s.newSession();
    expect(s.setPinned(a, true)).toBe(true);
    expect(s.list().find((x) => x.id === a)?.pinned).toBe(true);
    const again = new SessionStore(s.dir);
    expect(again.list().find((x) => x.id === a)?.pinned).toBe(true);
    again.setPinned(a, false);
    expect(new SessionStore(s.dir).list().find((x) => x.id === a)?.pinned).toBeUndefined();
    expect(s.setPinned('20990101-000000-zzzz', true)).toBe(false);
  });

  it('permanently deletes the selected log, and deleting the open one opens another', () => {
    const s = make();
    const a = s.id;
    s.addChat({ id: '旧的', role: 'user', content: '旧的' });
    const b = s.newSession();
    s.addChat({ id: '新的', role: 'user', content: '新的' });
    expect(s.remove(b)).toBe(true);
    expect(s.id).toBe(a);
    expect(s.list().map((x) => x.id)).toEqual([a]);
    expect(fs.existsSync(path.join(s.dir, `${b}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, 'trash', `${b}.jsonl`))).toBe(false);
    expect(s.remove(a)).toBe(true);                  // the last one: a fresh session takes its place
    expect(s.id).not.toBe(a);
    expect(s.list()).toHaveLength(1);
  });

  it('keeps a project folder per conversation', () => {
    const s = make();
    const a = s.id;
    s.setProject(platform!.folders.documents);
    expect(s.project()).toBe(platform!.folders.documents);
    s.newSession();
    expect(s.project()).toBeNull();
    expect(s.list().find((x) => x.id === a)?.project).toBe(platform!.folders.documents);
    s.switchTo(a);
    expect(new SessionStore(s.dir).project()).toBe(platform!.folders.documents);
  });
});

describe('project mode', () => {
  const setup = (steps: Parameters<typeof makeHarness>[0]): string => {
    h = makeHarness(steps);
    // A folder outside the default allowed ones: binding it as the project makes it usable.
    const project = path.join(h.platform.drive, 'D', 'code', 'game');
    fs.mkdirSync(project, { recursive: true });
    h.rt.sessions.setProject(project);
    return project;
  };

  it('relative paths land in the project; creating and editing there needs no confirmation', async () => {
    const project = setup([
      call('create_file', { path: 'src/main.py', content: 'print("hi")\nx = 1\n' }),
      call('edit_file', { path: 'src/main.py', old_text: 'x = 1', new_text: 'x = 2' }),
      call('write_file', { path: 'src/main.py', content: 'print("all new")\n' }),
      say('好了'),
    ]);
    const r = await h!.run('建个小项目');
    expect(r.confirms).toHaveLength(0);
    expect(finalSteps(r).every((s) => s.status === 'ok')).toBe(true);
    expect(fs.readFileSync(path.join(project, 'src', 'main.py'), 'utf8')).toBe('print("all new")\n');
    // She is told about the project.
    const system = String(h!.llm.requests[0]?.messages[0]?.content);
    expect(system).toContain('## 当前项目');
    expect(system).toContain(project);
  });

  it('speaks the app language', async () => {
    setup([say('OK'), say('はい')]);
    h!.lang = 'en';
    await h!.run('hi');
    expect(String(h!.llm.requests[0]?.messages[0]?.content)).toContain('Always speak to the user in English');
    h!.lang = 'ja';
    await h!.run('こんにちは');
    expect(String(h!.llm.requests[1]?.messages[0]?.content)).toContain('日本語で話すこと');
  });

  it('outside the project, editing an existing file still asks', async () => {
    h = makeHarness([]);
    const file = path.join(h.platform.folders.documents, 'note.txt');
    fs.writeFileSync(file, 'a\n');
    h.llm.push(call('edit_file', { path: file, old_text: 'a', new_text: 'b' }), say('好'));
    const r = await h.run('改一下', { decide: () => 'deny' });
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]?.risk).toBe('high');
    expect(fs.readFileSync(file, 'utf8')).toBe('a\n');
  });

  it('edit_file: exact, unique, keeps CRLF, can be undone', async () => {
    const project = setup([
      call('edit_file', { path: 'a.txt', old_text: 'missing', new_text: 'x' }),
      (m) => { expect(String(lastToolResult(m).error)).toContain('找不到'); return call('edit_file', { path: 'a.txt', old_text: 'same', new_text: 'x' }); },
      (m) => { expect(String(lastToolResult(m).error)).toContain('2 次'); return call('edit_file', { path: 'a.txt', old_text: 'line one\nsame', new_text: 'line 1\nchanged' }); },
      say('改好了'),
    ]);
    const file = path.join(project, 'a.txt');
    fs.writeFileSync(file, 'line one\r\nsame\r\nsame\r\n');
    const r = await h!.run('改一下 a.txt');
    expect(r.confirms).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('line 1\r\nchanged\r\nsame\r\n');
    const last = h!.rt.journal.recent(1)[0];
    expect(last?.tool).toBe('edit_file');
    expect(h!.rt.journal.undo({ entryId: last!.id }).failed).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\r\nsame\r\nsame\r\n');
  });

  it('deleting in the project and running commands still ask every time', async () => {
    const project = setup([
      call('delete_file', { path: 'old.txt' }),
      call('run_command', { command: 'echo hi' }),
      say('好'),
    ]);
    fs.writeFileSync(path.join(project, 'old.txt'), 'x');
    const r = await h!.run('删掉并运行', { decide: () => 'deny' });
    expect(r.confirms.map((c) => c.tool)).toEqual(['delete_file', 'run_command']);
    // run_command without cwd runs in the project folder.
    expect(r.confirms[1]?.preview.join('\n')).toContain(project);
    expect(fs.existsSync(path.join(project, 'old.txt'))).toBe(true);
  });

  it('cannot escape the project with ../ for free', async () => {
    const project = setup([
      call('create_file', { path: '../outside.txt', content: 'x' }),
      say('好'),
    ]);
    const r = await h!.run('试试', { decide: () => 'deny' });
    // The parent folder is not allowed at all here (not a default folder), so it is refused outright.
    expect(fs.existsSync(path.join(path.dirname(project), 'outside.txt'))).toBe(false);
    expect(finalSteps(r)[0]?.status).not.toBe('ok');
  });
});

/** Dropping files on the pet: path checks, the menu's choices, and the drop target behaviour. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectDrop } from '../electron/fileDrop';
import { dropActions, dropHeader, MAX_DROP_ITEMS, withAttachments, type DropSummary } from '../shared/fileDrop';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-drop-'));
const allowed = path.join(tmp, 'Desktop');
const elsewhere = path.join(tmp, 'Secret');
for (const d of [allowed, elsewhere, path.join(allowed, 'Pics')]) fs.mkdirSync(d, { recursive: true });
const mk = (dir: string, name: string): string => { const p = path.join(dir, name); fs.writeFileSync(p, 'x'); return p; };
const a = mk(allowed, 'a.txt'); mk(allowed, 'b.png'); const s = mk(elsewhere, 'key.txt');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('inspectDrop', () => {
  it('keeps real absolute paths, marks what is outside the allowed folders', () => {
    const d = inspectDrop([a, s, path.join(allowed, 'Pics')], [allowed]);
    expect(d?.items).toEqual([
      { path: a, kind: 'file', allowed: true },
      { path: s, kind: 'file', allowed: false },
      { path: path.join(allowed, 'Pics'), kind: 'dir', allowed: true },
    ]);
  });

  it('rejects junk from the renderer and merges duplicates', () => {
    const d = inspectDrop([a, a.toUpperCase(), 'relative.txt', path.join(allowed, 'missing.txt'), 42, `${a}\0x`], [allowed]);
    expect(d?.items.map((i) => i.path)).toEqual([a]);
    expect(d?.skipped).toBe(4);
    expect(inspectDrop('nope', [allowed])).toBeNull();
    expect(inspectDrop([], [allowed])).toBeNull();
  });

  it('caps the number of items', () => {
    const many = Array.from({ length: MAX_DROP_ITEMS + 5 }, (_, i) => mk(allowed, `f${i}.txt`));
    const d = inspectDrop(many, [allowed]);
    expect(d?.items).toHaveLength(MAX_DROP_ITEMS);
    expect(d?.skipped).toBe(5);
  });
});

const sum = (items: DropSummary['items'], skipped = 0): DropSummary => ({ items, skipped });
const f = (p: string, allowedFlag = true) => ({ path: p, kind: 'file' as const, allowed: allowedFlag });

describe('drop menu', () => {
  it('offers sensible choices for a folder', () => {
    const acts = dropActions(sum([{ path: 'C:\\Users\\me\\Desktop\\Pics', kind: 'dir', allowed: true }]));
    expect(acts.map((x) => x.id)).toEqual(['peek', 'organize', 'zip', 'ask']);
    expect(acts[0]?.compose.prompt).toContain('C:\\Users\\me\\Desktop\\Pics');
  });

  it('offers summary, organize, zip, rename and ask for a few files', () => {
    const acts = dropActions(sum([f('C:\\d\\a.txt'), f('C:\\d\\b.txt')]));
    expect(acts.map((x) => x.id)).toEqual(['summary', 'organize', 'zip', 'rename', 'ask']);
    // Rename needs the user's rule: it attaches instead of sending.
    expect(acts.find((x) => x.id === 'rename')?.compose.prompt).toBeUndefined();
    expect(acts.find((x) => x.id === 'rename')?.compose.hint).toContain('规则');
  });

  it('only ever includes the allowed paths, and offers nothing if none are', () => {
    const acts = dropActions(sum([f('C:\\d\\a.txt'), f('D:\\secret\\k.txt', false)]));
    for (const x of acts) { expect(x.compose.paths).toEqual(['C:\\d\\a.txt']); expect(x.compose.prompt ?? '').not.toContain('secret'); }
    expect(dropActions(sum([f('D:\\secret\\k.txt', false)]))).toEqual([]);
  });

  it('no summary for many files', () => {
    const acts = dropActions(sum(Array.from({ length: 6 }, (_, i) => f(`C:\\d\\${i}.txt`))));
    expect(acts.map((x) => x.id)).not.toContain('summary');
  });

  it('header and attachments read naturally', () => {
    expect(dropHeader(sum([f('C:\\d\\报告.docx')]))).toBe('收到「报告.docx」');
    expect(dropHeader(sum([f('C:\\a'), f('C:\\b'), { path: 'C:\\c', kind: 'dir', allowed: true }], 2))).toBe('收到 2 个文件、1 个文件夹（另有 2 个没收）');
    expect(withAttachments(' 改成小写 ', ['C:\\a.TXT'])).toBe('改成小写\n\n文件：\n- C:\\a.TXT');
    expect(withAttachments('hi', [])).toBe('hi');
  });
});

// ---------------------------------------------------------------- renderer side, with a tiny fake window
type Listener = (e: unknown) => void;
class FakeWindow {
  listeners = new Map<string, Listener[]>();
  addEventListener(t: string, fn: Listener): void { this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]); }
  removeEventListener(t: string, fn: Listener): void { this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== fn)); }
  fire(t: string, e: unknown): void { for (const fn of this.listeners.get(t) ?? []) fn(e); }
  setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number;
  clearTimeout = (id: number) => clearTimeout(id);
}
const dragEvent = (x: number, y: number, files: unknown[] = [{ name: 'a.txt' }], types = ['Files']) => {
  const e = { clientX: x, clientY: y, relatedTarget: null, dataTransfer: { types, files, dropEffect: 'none' }, prevented: false, preventDefault() { e.prevented = true; } };
  return e;
};

describe('FileDropController', () => {
  let win: FakeWindow;
  beforeEach(() => { win = new FakeWindow(); vi.stubGlobal('window', win); });
  afterEach(() => vi.unstubAllGlobals());

  const make = async () => {
    const { FileDropController } = await import('../src/engine/FileDropController');
    const calls: string[] = [];
    const dropped: unknown[][] = [];
    const c = new FileDropController({
      hitTest: (x) => ({ hit: x < 100 }),                   // her body is the left part
      onFileHover: () => calls.push('hover'),
      onFileHoverEnd: () => calls.push('end'),
      onFilesDropped: (files) => dropped.push(files),
    });
    return { c, calls, dropped };
  };

  it('accepts a drop only on her body', async () => {
    const { calls, dropped } = await make();
    const off = dragEvent(150, 10);
    win.fire('dragover', off);
    expect(off.prevented).toBe(false);                      // transparent part refuses
    const on = dragEvent(50, 10);
    win.fire('dragenter', on); win.fire('dragover', dragEvent(52, 10));
    expect(on.prevented).toBe(true);
    expect(on.dataTransfer.dropEffect).toBe('copy');
    expect(calls).toEqual(['hover']);                       // reacts once per drag
    win.fire('drop', dragEvent(50, 10, [{ name: 'a' }, { name: 'b' }]));
    expect(dropped).toEqual([[{ name: 'a' }, { name: 'b' }]]);
  });

  it('ignores drags that are not files, and drops off her body', async () => {
    const { calls, dropped } = await make();
    const text = dragEvent(50, 10, [], ['text/plain']);
    win.fire('dragover', text);
    expect(text.prevented).toBe(false);
    win.fire('dragover', dragEvent(50, 10));
    const offDrop = dragEvent(150, 10);
    win.fire('drop', offDrop);
    expect(offDrop.prevented).toBe(true);                   // never navigates to the file
    expect(dropped).toEqual([]);
    expect(calls).toEqual(['hover', 'end']);
  });

  it('reports the drag ending when it moves off her or goes stale', async () => {
    const { c, calls } = await make();
    win.fire('dragover', dragEvent(50, 10));
    expect(c.isActive()).toBe(true);
    win.fire('dragover', dragEvent(150, 10));
    expect(calls).toEqual(['hover', 'end']);
    win.fire('dragover', dragEvent(50, 10));
    await new Promise((r) => setTimeout(r, 450));
    expect(calls).toEqual(['hover', 'end', 'hover', 'end']);
    expect(c.isActive()).toBe(false);
  });
});

describe('InteractionController.cursorAt (polled cursor)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns click-through off over her body and back on elsewhere, but not mid-drag', async () => {
    vi.stubGlobal('window', new FakeWindow());
    vi.stubGlobal('document', { documentElement: new FakeWindow() });
    const { InteractionController } = await import('../src/engine/InteractionController');
    const ignore: boolean[] = [];
    let fileDrag = false;
    const el = Object.assign(new FakeWindow(), { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
    const ic = new InteractionController(el as unknown as HTMLElement, {
      hitTest: (x) => ({ hit: x < 100, head: false }), canDrag: () => true, setIgnoreMouse: (v) => ignore.push(v),
      onGrab: () => true, onRelease() {}, onClick() {}, onDoubleClick() {}, onPet() {}, onHover() {}, onContextMenu() {},
      isFileDragging: () => fileDrag,
    });
    ic.cursorAt({ x: 50, y: 10 });
    ic.cursorAt({ x: 60, y: 10 });                          // no repeat IPC
    ic.cursorAt({ x: 150, y: 10 });
    ic.cursorAt({ x: 50, y: 10 });
    ic.cursorAt(null);
    expect(ignore).toEqual([false, true, false, true]);
    // During a file drag the DOM may claim the mouse left: click-through must stay off.
    ic.cursorAt({ x: 50, y: 10 });
    fileDrag = true;
    (window as unknown as FakeWindow).fire('mouseleave', {});
    expect(ignore.at(-1)).toBe(false);
    ic.destroy();
  });
});

/** Long tasks: old tool output shrinks to its summary so the conversation stays inside the model's context. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clipArguments, ContextCompactor, totalChars } from '../../electron/agent/ContextCompactor';
import type { LlmMessage } from '../../electron/agent/llm';
import { call, makeHarness, say, type Harness } from './helpers';

let h: Harness;
afterEach(() => h?.cleanup());

const toolMsgs = (m: LlmMessage[]): string[] => m.filter((x) => x.role === 'tool').map((x) => String(x.content));

describe('ContextCompactor', () => {
  it('leaves small conversations alone', () => {
    const c = new ContextCompactor({ maxChars: 1000, keepRecentResults: 1, maxArgChars: 100 });
    const m: LlmMessage[] = [{ role: 'system', content: 's' }, { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(100) }];
    c.registerResult(m[1] as LlmMessage, 'short');
    expect(c.compact(m)).toBe(0);
    expect(m[1]?.content).toBe('x'.repeat(100));
  });

  it('shrinks oldest results first, keeps the newest, never touches user or system text', () => {
    const c = new ContextCompactor({ maxChars: 6100, keepRecentResults: 2, maxArgChars: 100 });
    const m: LlmMessage[] = [{ role: 'system', content: 'S'.repeat(1500) }, { role: 'user', content: 'U'.repeat(1500) }];
    for (let i = 0; i < 5; i++) {
      const msg: LlmMessage = { role: 'tool', tool_call_id: `c${i}`, content: `${i}`.repeat(1000) };
      m.push(msg); c.registerResult(msg, `short${i}`);
    }
    expect(c.compact(m)).toBeGreaterThan(0);
    expect(totalChars(m)).toBeLessThanOrEqual(6100);
    expect(toolMsgs(m).slice(0, 2)).toEqual(['short0', 'short1']);   // just enough to fit
    expect(toolMsgs(m)[2]).toBe('2'.repeat(1000));                  // the rest already fits
    expect(m[0]?.content).toBe('S'.repeat(1500));
    expect(m[1]?.content).toBe('U'.repeat(1500));
  });

  it('keeps the newest results whole even if still over budget', () => {
    const c = new ContextCompactor({ maxChars: 100, keepRecentResults: 2, maxArgChars: 100 });
    const m: LlmMessage[] = [];
    for (let i = 0; i < 3; i++) { const msg: LlmMessage = { role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(500) }; m.push(msg); c.registerResult(msg, 's'); }
    c.compact(m);
    expect(toolMsgs(m)).toEqual(['s', 'x'.repeat(500), 'x'.repeat(500)]);
  });

  it('clips long string arguments but keeps valid JSON', () => {
    const out = clipArguments(JSON.stringify({ path: 'a.txt', content: 'y'.repeat(5000), list: Array.from({ length: 30 }, (_, i) => i) }));
    const parsed = JSON.parse(out as string) as { path: string; content: string; list: unknown[] };
    expect(parsed.path).toBe('a.txt');
    expect(parsed.content.length).toBeLessThan(300);
    expect(parsed.content).toContain('已省略');
    expect(parsed.list).toHaveLength(21);
    expect(clipArguments('{broken')).toBeNull();
  });
});

describe('compaction inside a real task', () => {
  it('shrinks early file reads in a long task, keeps untrusted marking and the latest results', async () => {
    h = makeHarness([], { settings: { maxSteps: 20 } });
    h.rt.controller.compactOptions = { maxChars: 20_000, keepRecentResults: 2, maxArgChars: 500 };
    const files = Array.from({ length: 6 }, (_, i) => {
      const f = path.join(h.platform.folders.documents, `big${i}.txt`);
      fs.writeFileSync(f, `文件${i} `.repeat(1500));
      return f;
    });
    let seen: string[] = [];
    let total = 0;
    h.llm.push(
      ...files.map((f) => call('read_file', { path: f })),
      (m) => { seen = toolMsgs(m); total = totalChars(m); return say('都读完了'); },
    );
    const r = await h.run('把这几个文件都读一遍');
    expect(r.done?.outcome).toBe('success');
    expect(total).toBeLessThanOrEqual(20_000 + 12_000);      // the newest results are kept even past the budget
    expect(seen[0]).toContain('详细数据已省略');
    expect(seen[0]).toContain('<untrusted_data');           // still marked as file content
    expect(seen[0]).not.toContain('文件0 文件0');
    expect(seen[5]).toContain('文件5 文件5');               // the newest result is intact
    const log = fs.readFileSync(path.join(h.rt.logger.logDir, fs.readdirSync(h.rt.logger.logDir)[0] as string), 'utf8');
    expect(log).toContain('context_compacted');
  });

  it('clips the contents of an old write_file call once it is far behind', async () => {
    h = makeHarness([], { settings: { maxSteps: 20 } });
    h.rt.controller.compactOptions = { maxChars: 8000, keepRecentResults: 1, maxArgChars: 500 };
    const big = path.join(h.platform.folders.documents, 'big.txt');
    fs.writeFileSync(big, 'z'.repeat(9000));
    let args = '';
    h.llm.push(
      call('write_file', { path: '~/Documents/out.txt', content: 'w'.repeat(6000) }),
      call('read_file', { path: big }),
      call('get_known_folders', {}),
      (m) => {
        const a = m.find((x) => x.role === 'assistant' && 'tool_calls' in x && x.tool_calls?.[0]?.function.name === 'write_file');
        args = a && 'tool_calls' in a ? a.tool_calls?.[0]?.function.arguments ?? '' : '';
        return say('好');
      },
    );
    await h.run('写文件再看看');
    expect(fs.readFileSync(path.join(h.platform.folders.documents, 'out.txt'), 'utf8')).toHaveLength(6000);  // ran with full content
    expect(args.length).toBeLessThan(600);
    expect(JSON.parse(args)).toMatchObject({ path: '~/Documents/out.txt' });
  });
});

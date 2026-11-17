import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, lastToolResult, makeHarness, say } from './helpers';

describe('the shipped example plugin', () => {
  it('is discovered after approval and used by the agent without any agent code changes', async () => {
    const h = makeHarness();
    try {
      fs.cpSync(path.join(__dirname, '..', '..', 'examples', 'plugins', 'pick-random'), path.join(h.baseDir, 'plugins', 'pick-random'), { recursive: true });
      h.rt.plugins.approve('pick-random', true);
      await h.rt.plugins.reloadAll();
      expect(h.rt.registry.has('pick_random__pick_random')).toBe(true);
      h.llm.push(call('pick_random__pick_random', { options: ['面', '饭', '饺子'] }), (m) => { expect(lastToolResult(m)).toMatchObject({ ok: true, verified: true }); return say('吃饺子！'); });
      const r = await h.run('中午吃面、饭还是饺子？帮我随机选');
      expect(r.done?.outcome).toBe('success');
    } finally { h.cleanup(); }
  });
});

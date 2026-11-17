import type { AnyTool, ToolContext, ToolResult, VerifyResult } from './types';

const VERIFY_TIMEOUT_MS = 20_000;

/**
 * Checks the real world after a tool ran ("is the folder there now?", "did the app start?").
 * A tool that reports success but fails verification is treated as failed — the agent may not claim it.
 */
export class TaskVerifier {
  async verify(tool: AnyTool, args: unknown, result: ToolResult, ctx: ToolContext): Promise<VerifyResult | null> {
    if (!result.ok || !tool.verify) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        tool.verify(args, result, ctx),
        new Promise<VerifyResult>((resolve) => {
          timer = setTimeout(() => resolve({ verified: false, detail: '验证超时' }), VERIFY_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      return { verified: false, detail: `验证出错：${err instanceof Error ? err.message : String(err)}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Polls `check` until it returns true or the time runs out. */
  static async waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 400): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try { if (await check()) return true; } catch { /* keep polling */ }
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

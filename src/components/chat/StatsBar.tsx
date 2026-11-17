import type { JSX } from 'react';
import type { SessionStatsView } from '../../../shared/harness';
import { fmtMs, fmtTok } from './format';

/** Bottom bar: run stats of the current session (turns, steps, time, tokens, cache hits). */
export function StatsBar({ sessionId, stats, working }: { sessionId: string | null; stats: SessionStatsView | null; working: boolean }): JSX.Element {
  const t = stats?.total;
  const cache = t && t.hasTokens && t.inputTokens > 0 && t.cachedTokens > 0 ? Math.round((t.cachedTokens / t.inputTokens) * 100) : null;
  return (
    <div className="hx-stats" title={sessionId ? `会话 ${sessionId}` : undefined}>
      <span className={`hx-stats-state${working ? ' busy' : ''}`}>{working ? '工作中' : '空闲'}</span>
      {t ? (
        <>
          <span>{t.turns} 回合 · {t.steps} 步 · {t.toolCalls} 次工具</span>
          <span>模型 {fmtMs(t.llmMs)} · 工具 {fmtMs(t.toolMs)}</span>
          {t.hasTokens && <span>输入 {fmtTok(t.inputTokens)} · 输出 {fmtTok(t.outputTokens)}{cache !== null ? ` · 缓存 ${cache}%` : ''}</span>}
        </>
      ) : <span>—</span>}
    </div>
  );
}

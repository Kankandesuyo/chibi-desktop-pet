import type { JSX } from 'react';
import type { SessionStatsView } from '../../../shared/harness';
import { fmtMs, fmtTok } from './format';

/**
 * Bottom bar: run stats of the current session (turns, steps, time, tokens, cache hits) and how full the
 * context window got in the last turn (its largest prompt against the configured window).
 */
export function StatsBar({ sessionId, stats, working, contextWindow }: { sessionId: string | null; stats: SessionStatsView | null; working: boolean; contextWindow: number }): JSX.Element {
  const t = stats?.total;
  const cache = t && t.hasTokens && t.inputTokens > 0 && t.cachedTokens > 0 ? Math.round((t.cachedTokens / t.inputTokens) * 100) : null;
  const used = stats?.last?.peakInputTokens ?? 0;
  const pct = contextWindow > 0 && used > 0 ? Math.min(100, Math.round((used / contextWindow) * 100)) : null;
  const level = pct === null ? '' : pct >= 85 ? ' hot' : pct >= 60 ? ' warm' : '';
  return (
    <div className="hx-stats" title={sessionId ? `会话 ${sessionId}` : undefined}>
      <span className={`hx-stats-state${working ? ' busy' : ''}`}>{working ? '工作中' : '空闲'}</span>
      <span
        className={`hx-ctx${level}`}
        title={pct === null
          ? `上下文窗口 ${fmtTok(contextWindow)}：模型报告用量后显示这一回合用了多少（快满时会自动压缩旧的工具结果）`
          : `上一回合最大的一次请求用了 ${fmtTok(used)} / ${fmtTok(contextWindow)} 的上下文窗口；接近上限时会自动压缩旧的工具结果`}
      >
        上下文
        <span className="hx-ctx-bar"><span style={{ width: `${pct ?? 0}%` }} /></span>
        {pct === null ? `— / ${fmtTok(contextWindow)}` : `${pct}% · ${fmtTok(used)} / ${fmtTok(contextWindow)}`}
      </span>
      {t ? (
        <>
          <span>{t.turns} 回合 · {t.steps} 步 · {t.toolCalls} 次工具</span>
          <span>模型 {fmtMs(t.llmMs)} · 工具 {fmtMs(t.toolMs)}</span>
          {t.hasTokens && <span>输入 {fmtTok(t.inputTokens)} · 输出 {fmtTok(t.outputTokens)}{cache !== null ? ` · 缓存 ${cache}%` : ''}</span>}
        </>
      ) : null}
    </div>
  );
}

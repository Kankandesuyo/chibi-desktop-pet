import type { JSX } from 'react';
import type { SessionStatsView } from '../../../shared/harness';
import { fmtMs, fmtTok } from './format';
import { useT } from '../../i18n';

/**
 * Bottom bar: run stats of the current session (turns, steps, time, tokens, cache hits) and how full the
 * context window got in the last turn (its largest prompt against the configured window).
 */
export function StatsBar({ sessionId, stats, working, contextWindow }: { sessionId: string | null; stats: SessionStatsView | null; working: boolean; contextWindow: number }): JSX.Element {
  const tr = useT();
  const t = stats?.total;
  const cache = t && t.hasTokens && t.inputTokens > 0 && t.cachedTokens > 0 ? Math.round((t.cachedTokens / t.inputTokens) * 100) : null;
  const used = stats?.last?.peakInputTokens ?? 0;
  const pct = contextWindow > 0 && used > 0 ? Math.min(100, Math.round((used / contextWindow) * 100)) : null;
  const level = pct === null ? '' : pct >= 85 ? ' hot' : pct >= 60 ? ' warm' : '';
  return (
    <div className="hx-stats" title={sessionId ? tr('会话 {id}', { id: sessionId }) : undefined}>
      <span className={`hx-stats-state${working ? ' busy' : ''}`}>{working ? tr('工作中') : tr('空闲')}</span>
      <span
        className={`hx-ctx${level}`}
        title={pct === null
          ? tr('上下文窗口 {size}：模型报告用量后显示这一回合用了多少（快满时会自动压缩旧的工具结果）', { size: fmtTok(contextWindow) })
          : tr('上一回合最大的一次请求用了 {used} / {size} 的上下文窗口；接近上限时会自动压缩旧的工具结果', { used: fmtTok(used), size: fmtTok(contextWindow) })}
      >
        {tr('上下文')}
        <span className="hx-ctx-bar"><span style={{ width: `${pct ?? 0}%` }} /></span>
        {pct === null ? `— / ${fmtTok(contextWindow)}` : `${pct}% · ${fmtTok(used)} / ${fmtTok(contextWindow)}`}
      </span>
      {t ? (
        <>
          <span>{tr('{turns} 回合 · {steps} 步 · {tools} 次工具', { turns: t.turns, steps: t.steps, tools: t.toolCalls })}</span>
          <span>{tr('模型 {llm} · 工具 {tool}', { llm: fmtMs(t.llmMs), tool: fmtMs(t.toolMs) })}</span>
          {t.hasTokens && <span>{tr('输入 {input} · 输出 {output}', { input: fmtTok(t.inputTokens), output: fmtTok(t.outputTokens) })}{cache !== null ? tr(' · 缓存 {pct}%', { pct: cache }) : ''}</span>}
        </>
      ) : null}
    </div>
  );
}

import { useEffect, useState, type JSX } from 'react';
import type { TrajectoryEvent, TurnStats } from '../../../shared/harness';
import { clock, fmtMs, fmtTok } from './format';
import { tNow, useT } from '../../i18n';

/**
 * The raw timeline of the current session (from the session log): every model call, what it asked for
 * with its arguments, every tool result, compaction, and how each turn ended. Already redacted.
 */

interface Turn { id: string; start?: TrajectoryEvent; end?: TrajectoryEvent; events: TrajectoryEvent[] }

const REASON: Record<string, string> = { completed: '完成', aborted: '已停止', error: '出错', 'max-steps': '到步骤上限', interrupted: '被打断' };
const STATUS: Record<string, string> = { ok: '成功', failed: '失败', denied: '未执行', invalid: '格式错误' };

function group(events: TrajectoryEvent[]): Turn[] {
  const turns = new Map<string, Turn>();
  for (const e of events) {
    if (!e.turnId) continue;
    const t = turns.get(e.turnId) ?? { id: e.turnId, events: [] };
    if (e.type === 'turn/start') t.start = e;
    else if (e.type === 'turn/end') t.end = e;
    else t.events.push(e);
    turns.set(e.turnId, t);
  }
  return [...turns.values()];
}

function Row({ e, t0 }: { e: TrajectoryEvent; t0: number }): JSX.Element | null {
  const t = useT();
  const [raw, setRaw] = useState(false);
  const offset = `+${((Date.parse(e.t) - t0) / 1000).toFixed(1)}s`;
  let lane = '系统';
  let body: JSX.Element;
  if (e.type === 'step/start') {
    lane = '模型';
    body = <span className="hx-traj-muted">{t('第 {n} 次请求模型', { n: Number(e.step) + 1 })}</span>;
  } else if (e.type === 'assistant/message') {
    lane = '模型';
    const calls = (e.calls as { id: string; name: string; args: string }[] | undefined) ?? [];
    body = (
      <div>
        {typeof e.text === 'string' && e.text.trim() && <p className="hx-traj-text">{e.text}</p>}
        {calls.map((c) => <div key={c.id} className="hx-traj-call"><code>{c.name}</code><pre>{c.args}</pre></div>)}
      </div>
    );
  } else if (e.type === 'tool/result') {
    lane = '工具';
    const r = (e.result ?? {}) as { title?: string; status?: string; summary?: string; data?: string };
    body = (
      <div>
        <div><code>{String(e.name)}</code> <span className={`hx-traj-status s-${r.status}`}>{t(STATUS[r.status ?? ''] ?? r.status ?? '')}</span> {r.title}</div>
        {r.summary && <p className="hx-traj-text">{r.summary}</p>}
        {r.data && <pre>{r.data}</pre>}
      </div>
    );
  } else if (e.type === 'compaction') {
    body = <span className="hx-traj-muted">{t('压缩上下文，省下 {n} 字', { n: fmtTok(Number(e.savedChars)) })}</span>;
  } else {
    return null;
  }
  return (
    <li className={`hx-traj-row lane-${lane}`}>
      <span className="hx-traj-time">{offset}</span>
      <span className="hx-traj-lane">{t(lane)}</span>
      <div className="hx-traj-body">
        {body}
        <button type="button" className="hx-traj-raw" onClick={() => setRaw(!raw)}>{raw ? t('收起原始数据') : t('原始数据')}</button>
        {raw && <pre className="hx-traj-json">{JSON.stringify(e, null, 2)}</pre>}
      </div>
    </li>
  );
}

function statsLine(s: TurnStats | undefined): string {
  if (!s) return '';
  const parts = [tNow('{n} 步', { n: s.steps }), tNow('模型 {ms}', { ms: fmtMs(s.llmMs) }), tNow('工具 {ms}', { ms: fmtMs(s.toolMs) })];
  if (s.inputTokens !== undefined) parts.push(tNow('输入 {input} · 输出 {output}', { input: fmtTok(s.inputTokens), output: fmtTok(s.outputTokens ?? 0) }));
  return parts.join(' · ');
}

export function Trajectory({ refreshKey }: { refreshKey: string }): JSX.Element {
  const tr = useT();
  const [events, setEvents] = useState<TrajectoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.petAPI.trajectory().then((r) => {
      if (!alive) return;
      if ('error' in r) setError(r.error); else { setEvents(r.events); setError(null); }
    });
    return () => { alive = false; };
  }, [refreshKey]);

  if (error) return <p className="hx-empty">{error}</p>;
  if (!events) return <p className="hx-empty">{tr('读取中…')}</p>;
  const turns = group(events);
  if (!turns.length) return <p className="hx-empty">{tr('这个会话还没有做过任务。让她做点事，这里会显示每一次模型请求和工具调用。')}</p>;
  return (
    <div className="hx-traj">
      {turns.map((t) => {
        const t0 = Date.parse((t.start ?? t.events[0] ?? t.end)?.t ?? '') || 0;
        return (
          <section key={t.id} className="hx-traj-turn">
            <header>
              <span className="hx-traj-clock">{t.start ? clock(t.start.t) : ''}</span>
              <span className="hx-traj-user">{String(t.start?.userText ?? '')}</span>
            </header>
            <ol>{t.events.map((e) => <Row key={e.seq} e={e} t0={t0} />)}</ol>
            <footer>
              {t.end ? <span className={`hx-traj-end r-${String(t.end.reason)}`}>{tr(REASON[String(t.end.reason)] ?? String(t.end.reason))}</span> : <span className="hx-traj-end r-running">{tr('进行中')}</span>}
              <span>{statsLine(t.end?.stats as TurnStats | undefined)}</span>
            </footer>
          </section>
        );
      })}
    </div>
  );
}

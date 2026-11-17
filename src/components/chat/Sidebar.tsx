import type { JSX } from 'react';
import type { SessionSummary } from '../../../shared/harness';
import { dayGroup, shortDate } from './format';

interface Props {
  sessions: SessionSummary[];
  current: string | null;
  busy: boolean;
  name: string;
  avatar: string;
  onOpen(id: string): void;
  onNew(): void;
  onSettings(): void;
}

/** Left column: new session, sessions grouped by day, and her at the bottom. */
export function Sidebar({ sessions, current, busy, name, avatar, onOpen, onNew, onSettings }: Props): JSX.Element {
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const g = dayGroup(s.updatedAt);
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  return (
    <aside className="hx-side">
      <button type="button" className="hx-new" onClick={onNew} disabled={busy} title={busy ? '她正在做事，做完再开新会话' : '开始新会话（/new）'}>＋ 新会话</button>
      <nav className="hx-sessions">
        {[...groups].map(([label, list]) => (
          <section key={label}>
            <h4>{label}</h4>
            {list.map((s) => (
              <button
                key={s.id} type="button" className={`hx-session${s.id === current ? ' current' : ''}`}
                onClick={() => s.id !== current && onOpen(s.id)} disabled={busy && s.id !== current}
                title={`${s.title}\n${s.id}`}
              >
                <span className="hx-session-title">{s.title}</span>
                <span className="hx-session-time">{shortDate(s.updatedAt)}</span>
              </button>
            ))}
          </section>
        ))}
        {sessions.length === 0 && <p className="hx-side-empty">还没有会话</p>}
      </nav>
      <div className="hx-side-foot">
        {avatar ? <img src={avatar} alt="" className="hx-avatar" /> : <span className="hx-avatar" />}
        <span className="hx-side-name">{name}</span>
        <button type="button" onClick={onSettings} title="设置">⚙</button>
      </div>
    </aside>
  );
}

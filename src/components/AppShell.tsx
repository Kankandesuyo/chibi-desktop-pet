import { useCallback, useEffect, useState, type JSX } from 'react';
import type { SessionSummary } from '../../shared/harness';
import type { PanelAction, PanelState, UiMode } from '../../shared/types';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { ChatView } from './ChatView';
import { dayGroup, shortDate } from './chat/format';
import { ProfilePage } from './pages/ProfilePage';
import { SchedulesPage } from './pages/SchedulesPage';
import { SettingsPage } from './pages/SettingsPage';
import { SkillsPage } from './pages/SkillsPage';

export type Page = 'chat' | 'schedules' | 'skills' | 'profile' | 'settings';
const PAGES: readonly Page[] = ['chat', 'schedules', 'skills', 'profile', 'settings'];
export const isPage = (p: unknown): p is Page => typeof p === 'string' && (PAGES as readonly string[]).includes(p);

const UI_NEXT: Record<UiMode, UiMode> = { system: 'light', light: 'dark', dark: 'system' };
const UI_LABEL: Record<UiMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
const UI_ICON: Record<UiMode, string> = { system: '◐', light: '☀', dark: '☾' };

/**
 * The main window: a left navigation (her, new session, the sessions, schedules, skills, the user's
 * profile, settings, light/dark) and the page on the right. One window for everything; the native
 * window buttons sit over the top-right corner of the page header.
 */
export function AppShell({ initialPage }: { initialPage: Page }): JSX.Element {
  const [page, setPage] = useState<Page>(initialPage);
  const settings = useSettingsStore((s) => s.settings);
  const { requestId, session, messages } = useChatStore();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [avatar, setAvatar] = useState('');
  const [userAvatar, setUserAvatar] = useState('');
  const [panel, setPanel] = useState<PanelState>({ pinned: false, fullscreen: false, maximized: false });
  const busy = requestId !== null;
  const name = settings.petName || '她';

  const control = (a: PanelAction): void => { void window.petAPI.panelControl(a).then((s) => { if (s) setPanel(s); }); };
  const refreshSessions = useCallback((): void => {
    void window.petAPI.sessionsList().then((r) => { if (!('error' in r)) setSessions(r.sessions); });
  }, []);

  useEffect(() => {
    const offNav = window.petAPI.onNavigate((p) => { if (isPage(p)) setPage(p); });
    const offPanel = window.petAPI.onPanelState(setPanel);
    const offSettings = window.petAPI.onSettings((s) => {
      const prev = useSettingsStore.getState().settings;
      useSettingsStore.getState().apply(s);
      if (s.character !== prev.character) void window.petAPI.petAvatar().then(setAvatar);
      if (s.profile.hasAvatar !== prev.profile.hasAvatar) void window.petAPI.userAvatar().then(setUserAvatar);
    });
    void window.petAPI.panelControl('state').then((s) => { if (s) setPanel(s); });
    void window.petAPI.petAvatar().then(setAvatar);
    void window.petAPI.userAvatar().then(setUserAvatar);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && document.fullscreenElement === null) void window.petAPI.panelControl('state').then((s) => { if (s?.fullscreen) control('toggle-fullscreen'); });
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); setPage('settings'); }
      if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newSession(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { offNav(); offPanel(); offSettings(); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The list changes when the session changes, and a new session gets its title from its first message.
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  useEffect(() => { refreshSessions(); }, [session?.id, firstUser, refreshSessions]);

  const openSession = (id: string): void => {
    setPage('chat');
    if (id === session?.id) return;
    void window.petAPI.sessionOpen(id).then((r) => { if ('error' in r) useChatStore.setState({ notice: r.error }); refreshSessions(); });
  };
  function newSession(): void {
    setPage('chat');
    if (useChatStore.getState().requestId) return;
    if (window.petAPI.sharedClear) void window.petAPI.sessionNew().then((r) => { if ('error' in r) useChatStore.setState({ notice: r.error }); refreshSessions(); });
    else useChatStore.getState().clear();
  }

  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) groups.set(dayGroup(s.updatedAt), [...(groups.get(dayGroup(s.updatedAt)) ?? []), s]);
  const uiMode = settings.uiMode;
  const p = settings.profile;
  const me = p.displayName || p.callMe || '我';

  const controls = (
    <span className="page-controls">
      <button type="button" className={`tb-btn${panel.pinned ? ' on' : ''}`} onClick={() => control('toggle-pin')} title={panel.pinned ? '已置顶：点一下取消' : '窗口始终在最前面'}>📌</button>
      <button type="button" className={`tb-btn${panel.fullscreen ? ' on' : ''}`} onClick={() => control('toggle-fullscreen')} title={panel.fullscreen ? '退出全屏（F11 / Esc）' : '全屏（F11）'}>{panel.fullscreen ? '⤡' : '⤢'}</button>
    </span>
  );
  const nav = (id: Page, icon: string, label: string, extra?: string): JSX.Element => (
    <button type="button" className={`nav-item${page === id ? ' on' : ''}`} onClick={() => setPage(id)} title={extra}>
      <span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>
    </button>
  );

  return (
    <div className={`app${panel.fullscreen ? ' is-full' : ''}`}>
      <aside className="nav">
        <div className="nav-brand">
          {avatar ? <img src={avatar} alt="" className="hx-avatar" /> : <span className="hx-avatar" />}
          <span className="nav-brand-name">{name}</span>
          {busy && <span className="nav-busy" title="她正在做事">●</span>}
        </div>
        <button type="button" className="nav-new" onClick={newSession} disabled={busy} title={busy ? '她正在做事，做完再开新会话' : '开始新会话（Ctrl+N，/new）'}>＋ 新会话</button>
        <div className="nav-group nav-main">
          {nav('chat', '💬', '会话')}
          <div className="nav-sessions">
            {[...groups].map(([label, list]) => (
              <section key={label}>
                <h4>{label}</h4>
                {list.map((s) => (
                  <button
                    key={s.id} type="button" className={`hx-session${s.id === session?.id ? ' current' : ''}`}
                    onClick={() => openSession(s.id)} disabled={busy && s.id !== session?.id}
                    title={`${s.title}\n${s.id}`}
                  >
                    <span className="hx-session-title">{s.title}</span>
                    <span className="hx-session-time">{shortDate(s.updatedAt)}</span>
                  </button>
                ))}
              </section>
            ))}
            {sessions.length === 0 && <p className="hx-side-empty">还没有会话</p>}
          </div>
        </div>
        <div className="nav-group nav-fixed">
          {nav('schedules', '⏰', '定时任务')}
          {nav('skills', '🧩', '技能')}
          {nav('profile', '👤', '我的资料')}
          {nav('settings', '⚙', '设置', 'Ctrl+,')}
        </div>
        <div className="nav-foot">
          <button type="button" className="nav-me" onClick={() => setPage('profile')} title="我的资料">
            {userAvatar ? <img src={userAvatar} alt="" className="hx-avatar small" /> : <span className="hx-avatar small hx-avatar-letter">{me.slice(0, 1)}</span>}
            <span>{me}</span>
          </button>
          <button
            type="button" className="nav-mode" title={`外观：${UI_LABEL[uiMode]}（点一下切换到${UI_LABEL[UI_NEXT[uiMode]]}）`}
            onClick={() => void useSettingsStore.getState().update({ uiMode: UI_NEXT[uiMode] })}
          >{UI_ICON[uiMode]}</button>
        </div>
      </aside>

      <main className="content">
        <ChatView active={page === 'chat'} avatar={avatar} userAvatar={userAvatar} onWanted={() => setPage('chat')} controls={controls} />
        {page === 'schedules' && <SchedulesPage controls={controls} />}
        {page === 'skills' && <SkillsPage controls={controls} />}
        {page === 'profile' && <ProfilePage controls={controls} userAvatar={userAvatar} onAvatar={setUserAvatar} />}
        {page === 'settings' && <SettingsPage controls={controls} />}
      </main>
    </div>
  );
}

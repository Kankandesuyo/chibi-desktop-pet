import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { SessionSummary } from '../../shared/harness';
import type { PanelAction, PanelState, UiMode, UpdateStatus } from '../../shared/types';
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
  const [menu, setMenu] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>({ ready: false });
  const [installing, setInstalling] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
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
    const offUpdate = window.petAPI.onUpdate(setUpdate);
    void window.petAPI.updateStatus().then(setUpdate);
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
      if (e.key === 'Escape') {
        if (menuRef.current?.dataset.open === '1') { setMenu(false); return; }
        if (pageRef.current !== 'chat' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) { setPage('chat'); return; }
      }
      if (e.key === 'Escape' && document.fullscreenElement === null) void window.petAPI.panelControl('state').then((s) => { if (s?.fullscreen) control('toggle-fullscreen'); });
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); setPage('settings'); }
      if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newSession(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { offNav(); offPanel(); offUpdate(); offSettings(); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The avatar menu closes on any click outside it.
  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent): void => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [menu]);
  const go = (p: Page): void => { setMenu(false); setPage(p); };
  const installUpdate = (): void => {
    if (useChatStore.getState().requestId && !window.confirm('她正在做事，现在更新会打断她。仍然更新并重启吗？')) return;
    setInstalling(true);
    void window.petAPI.updateApply().then((r) => { if (!r.ok) { setInstalling(false); useChatStore.setState({ notice: `更新失败：${r.error ?? '未知原因'}` }); } });
  };

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
  // Every page but the chat gets a close button (left of its title) that goes back to the chat; Esc does the same.
  const pageControls = (
    <>
      <button type="button" className="page-close" onClick={() => setPage('chat')} title="关闭，回到会话（Esc）">✕</button>
      {controls}
    </>
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
        {update.ready && (
          <button type="button" className="nav-update" onClick={installUpdate} disabled={installing} title="安装新版本，桌宠会自动重启（几秒钟）">
            {installing ? '正在更新，马上回来…' : '⬆ 有新版本 · 点此更新'}
          </button>
        )}
        <div className="nav-foot" ref={menuRef} data-open={menu ? '1' : '0'}>
          {menu && (
            <div className="me-menu" role="menu">
              <button type="button" role="menuitem" className={page === 'schedules' ? 'on' : ''} onClick={() => go('schedules')}><span className="nav-icon">⏰</span>定时任务</button>
              <button type="button" role="menuitem" className={page === 'skills' ? 'on' : ''} onClick={() => go('skills')}><span className="nav-icon">🧩</span>技能</button>
              <hr />
              <button type="button" role="menuitem" className={page === 'profile' ? 'on' : ''} onClick={() => go('profile')}><span className="nav-icon">👤</span>我的资料</button>
              <button type="button" role="menuitem" className={page === 'settings' ? 'on' : ''} onClick={() => go('settings')}><span className="nav-icon">⚙</span>设置<kbd>Ctrl+,</kbd></button>
            </div>
          )}
          <button type="button" className={`nav-me${menu || page !== 'chat' ? ' on' : ''}`} onClick={() => setMenu((m) => !m)} title="定时任务、技能、我的资料、设置" aria-haspopup="menu" aria-expanded={menu}>
            {userAvatar ? <img src={userAvatar} alt="" className="hx-avatar small" /> : <span className="hx-avatar small hx-avatar-letter">{me.slice(0, 1)}</span>}
            <span className="nav-me-name">{me}</span><span className="nav-me-caret">{menu ? '▾' : '▴'}</span>
          </button>
          <button
            type="button" className="nav-mode" title={`外观：${UI_LABEL[uiMode]}（点一下切换到${UI_LABEL[UI_NEXT[uiMode]]}）`}
            onClick={() => void useSettingsStore.getState().update({ uiMode: UI_NEXT[uiMode] })}
          >{UI_ICON[uiMode]}</button>
        </div>
      </aside>

      <main className="content">
        <ChatView active={page === 'chat'} avatar={avatar} userAvatar={userAvatar} onWanted={() => setPage('chat')} controls={controls} />
        {page === 'schedules' && <SchedulesPage controls={pageControls} />}
        {page === 'skills' && <SkillsPage controls={pageControls} />}
        {page === 'profile' && <ProfilePage controls={pageControls} userAvatar={userAvatar} onAvatar={setUserAvatar} />}
        {page === 'settings' && <SettingsPage controls={pageControls} />}
      </main>
    </div>
  );
}

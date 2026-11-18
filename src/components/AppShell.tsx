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
import { useT } from '../i18n';
import { BrowserPane } from './BrowserPane';
import type { BrowserPaneState } from '../../shared/types';

export type Page = 'chat' | 'schedules' | 'skills' | 'profile' | 'settings';
const PAGES: readonly Page[] = ['chat', 'schedules', 'skills', 'profile', 'settings'];
export const isPage = (p: unknown): p is Page => typeof p === 'string' && (PAGES as readonly string[]).includes(p);

const UI_NEXT: Record<UiMode, UiMode> = { system: 'light', light: 'dark', dark: 'system' };
const UI_LABEL: Record<UiMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
const UI_ICON: Record<UiMode, string> = { system: '◐', light: '☀', dark: '☾' };

type NavMode = 'chat' | 'code';
/** Per-viewer conveniences only (which sidebar view, which groups are folded): fine to lose. */
const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const save = (key: string, value: unknown): void => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };
const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

const ChatIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 12.5a7.5 7.5 0 0 1-11.2 6.5L4 20l1.1-4.3A7.5 7.5 0 1 1 20 12.5Z" />
  </svg>
);
const CodeIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15" />
  </svg>
);
const LaptopIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4.5" y="5" width="15" height="10" rx="1.5" /><path d="M2.5 18.5h19" />
  </svg>
);
const FolderIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /><path d="M3.5 10h17" />
  </svg>
);
const SidebarIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" />
  </svg>
);
const Caret = ({ open }: { open: boolean }): JSX.Element => (
  <svg className={`fold-caret${open ? ' open' : ''}`} viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
  </svg>
);

/**
 * The main window: a left navigation (her, new session, the sessions, schedules, skills, the user's
 * profile, settings, light/dark) and the page on the right. One window for everything; the native
 * window buttons sit over the top-right corner of the page header.
 */
export function AppShell({ initialPage }: { initialPage: Page }): JSX.Element {
  const t = useT();
  const [browser, setBrowser] = useState<BrowserPaneState>({ open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
  const [browserWidth, setBrowserWidthState] = useState<number>(() => load<number>('browser.width', 520));
  const setBrowserWidth = (w: number): void => { const v = Math.max(320, Math.min(w, window.innerWidth - 232 - 380)); setBrowserWidthState(v); save('browser.width', v); };
  useEffect(() => { void window.petAPI.browserState().then(setBrowser); return window.petAPI.onBrowser(setBrowser); }, []);
  const [page, setPage] = useState<Page>(initialPage);
  const [menu, setMenu] = useState(false);
  const [navMode, setNavModeState] = useState<NavMode>(() => load<NavMode>('nav.mode', 'chat'));
  const [codeDraftId, setCodeDraftId] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<string[]>(() => load<string[]>('nav.folded', []));
  const setNavMode = (m: NavMode): void => { setNavModeState(m); save('nav.mode', m); };
  const [navCollapsed, setNavCollapsedState] = useState<boolean>(() => load<boolean>('nav.collapsed', false));
  const toggleNav = (): void => setNavCollapsedState((c) => { save('nav.collapsed', !c); return !c; });
  const isFolded = (key: string): boolean => folded.includes(key);
  const toggleFold = (key: string): void => setFolded((f) => { const next = f.includes(key) ? f.filter((k) => k !== key) : [...f, key]; save('nav.folded', next); return next; });
  const [update, setUpdate] = useState<UpdateStatus>({ ready: false });
  const [installing, setInstalling] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const settings = useSettingsStore((s) => s.settings);
  const { requestId, session, messages } = useChatStore();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [namedProjects, setNamedProjects] = useState<Record<string, string>>(() => load('nav.namedProjects', {}));
  const [naming, setNaming] = useState<{ kind: 'group' } | { kind: 'session'; id: string } | null>(null);
  const [nameInput, setNameInput] = useState('');
  const savingName = useRef(false);
  const projectLabel = (folder: string) => namedProjects[folder] ?? folderName(folder);
  const [avatar, setAvatar] = useState('');
  const [userAvatar, setUserAvatar] = useState('');
  const [panel, setPanel] = useState<PanelState>({ pinned: false, fullscreen: false, maximized: false });
  const busy = requestId !== null;
  const name = settings.petName || t('她');

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
  useEffect(() => {
    if (!pickOpen) return;
    const off = (e: MouseEvent): void => { if (!pickRef.current?.contains(e.target as Node)) setPickOpen(false); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [pickOpen]);
  const installUpdate = (): void => {
    if (useChatStore.getState().requestId && !window.confirm(t('她正在做事，现在更新会打断她。仍然更新并重启吗？'))) return;
    setInstalling(true);
    void window.petAPI.updateApply().then((r) => { if (!r.ok) { setInstalling(false); useChatStore.setState({ notice: t('更新失败：{error}', { error: r.error ?? t('未知原因') }) }); } });
  };

  // The list changes when the session changes, and a new session gets its title from its first message.
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  useEffect(() => { refreshSessions(); }, [session?.id, firstUser, refreshSessions]);

  const openSession = (id: string): void => {
    setPage('chat');
    if (id === session?.id) return;
    void window.petAPI.sessionOpen(id).then((r) => { if ('error' in r) useChatStore.setState({ notice: r.error }); refreshSessions(); });
  };
  const report = (r: { error: string } | object): boolean => {
    if ('error' in r) { useChatStore.setState({ notice: (r as { error: string }).error }); return false; }
    return true;
  };
  /** Picks a folder and opens a new conversation that works in it (fresh) — or rebinds the open one. */
  const chooseProject = async (fresh: boolean): Promise<void> => {
    if (useChatStore.getState().requestId) { useChatStore.setState({ notice: t('她正在做事，做完再换项目') }); return; }
    const folder = await window.petAPI.agentPickFolder();
    if (!folder) return;
    setPage('chat');
    if (report(await window.petAPI.sessionProject(folder, fresh))) setNavMode('code');
    refreshSessions();
  };
  /** From the strip above the input: work in this folder (the open conversation if it is still empty, else a new one). */
  const useProject = async (folder: string | null): Promise<void> => {
    setPickOpen(false);
    if (useChatStore.getState().requestId) { useChatStore.setState({ notice: t('她正在做事，做完再换项目') }); return; }
    if (!folder) folder = await window.petAPI.agentPickFolder();
    if (!folder) return;
    const fresh = useChatStore.getState().messages.length > 0;
    if (report(await window.petAPI.sessionProject(folder, fresh))) setNavMode('code');
    refreshSessions();
  };
  const useComputer = async (): Promise<void> => {
    if (!currentProjectRef.current) return;
    if (useChatStore.getState().messages.length > 0 && !window.confirm(t('这个对话不再绑定项目文件夹，改为在整台电脑上工作？'))) return;
    const id = useChatStore.getState().session?.id ?? null;
    if (report(await window.petAPI.sessionProject(null))) setCodeDraftId(id);
    refreshSessions();
  };

  /** A new conversation (thread) inside an existing project. */
  const newThread = async (folder: string): Promise<void> => {
    if (useChatStore.getState().requestId) { useChatStore.setState({ notice: t('她正在做事，做完再开新对话') }); return; }
    setPage('chat');
    report(await window.petAPI.sessionProject(folder, true));
    refreshSessions();
  };
  const unbindProject = async (): Promise<void> => { report(await window.petAPI.sessionProject(null)); refreshSessions(); };
  const togglePin = async (s: SessionSummary): Promise<void> => { report(await window.petAPI.sessionPin(s.id, !s.pinned)); refreshSessions(); };
  const removeSession = async (s: SessionSummary): Promise<void> => {
    if (!window.confirm(t('删除会话「{title}」？\n\n该会话记录将被永久删除，此操作无法撤销。', { title: s.title }))) return;
    report(await window.petAPI.sessionDelete(s.id));
    refreshSessions();
  };

  function newSession(): void {
    setCodeDraftId(null);
    setPage('chat');
    setNavMode('chat');
    if (useChatStore.getState().requestId) return;
    if (window.petAPI.sharedClear) void window.petAPI.sessionNew().then((r) => { if ('error' in r) useChatStore.setState({ notice: r.error }); refreshSessions(); });
    else useChatStore.getState().clear();
  }

  // Chat view: conversations without a project, pinned first, then by day.
  const chats = sessions.filter((s) => !s.project);
  const groups = new Map<string, SessionSummary[]>();
  const pinned = chats.filter((s) => s.pinned);
  if (pinned.length) groups.set('📌 置顶', pinned);
  for (const s of chats) if (!s.pinned) groups.set(dayGroup(s.updatedAt), [...(groups.get(dayGroup(s.updatedAt)) ?? []), s]);
  // Code view: one folder per project (most recently used first), its conversations inside, pinned first.
  const projects = new Map<string, SessionSummary[]>();
  for (const folder of Object.keys(namedProjects)) projects.set(folder, []);
  for (const s of sessions) if (s.project) projects.set(s.project, [...(projects.get(s.project) ?? []), s]);
  for (const list of projects.values()) list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  const currentProject = sessions.find((s) => s.current)?.project ?? null;
  // Opening (or starting) a conversation shows the view it belongs to.
  const currentId = sessions.find((s) => s.current)?.id ?? null;
  const currentProjectRef = useRef<string | null>(null);
  currentProjectRef.current = currentProject;
  useEffect(() => {
    if (!currentId) return;
    const want: NavMode = currentProject || currentId === codeDraftId ? 'code' : 'chat';
    if (want !== navMode) setNavMode(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, currentProject, codeDraftId]);
  const recentProjects = [...projects.keys()];
  // Above the input box in the code view: where she works — the whole computer, or a project folder.
  const codeStrip = navMode === 'code' ? (
    <div className="code-strip">
      <button type="button" className={`code-strip-tab${currentProject ? '' : ' on'}`} onClick={() => void useComputer()} disabled={busy} title={t('不绑定项目，在整台电脑上工作')}>
        <LaptopIcon /><span>{t('这台电脑')}</span>
      </button>
      <div className="code-strip-pick" ref={pickRef}>
        <button type="button" className={`code-strip-tab${currentProject ? ' on' : ''}`} onClick={() => setPickOpen((o) => !o)} disabled={busy} title={currentProject ?? t('选一个项目文件夹')} aria-haspopup="listbox" aria-expanded={pickOpen}>
          <FolderIcon /><span className="code-strip-name">{currentProject ? projectLabel(currentProject) : t('选择项目')}</span><Caret open={pickOpen} />
        </button>
        {pickOpen && (
          <div className="code-strip-menu" role="listbox">
            {recentProjects.length > 0 && <div className="code-strip-label">{t('最近的项目')}</div>}
            {recentProjects.map((f) => (
              <button key={f} type="button" role="option" aria-selected={f === currentProject} className={f === currentProject ? 'on' : ''} onClick={() => void useProject(f)} title={f}>
                <FolderIcon /><span className="code-strip-item"><b>{projectLabel(f)}</b><small>{f}</small></span>
              </button>
            ))}
            {recentProjects.length > 0 && <hr />}
            <button type="button" onClick={() => void useProject(null)}><span className="code-strip-plus">＋</span><span className="code-strip-item"><b>{t('选择文件夹…')}</b><small>{t('打开电脑上的任意文件夹作为项目')}</small></span></button>
          </div>
        )}
      </div>
    </div>
  ) : null;
  const browserToggle = (
    <button
      type="button" className={`head-icon${browser.open ? ' on' : ''}`} title={browser.open ? t('关闭浏览器') : t('打开内置浏览器')}
      onClick={() => void window.petAPI.browserControl(browser.open ? { type: 'close' } : { type: 'open' })}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5Z" />
      </svg>
    </button>
  );
  const projectChip = currentProject ? (
    <span className="project-chip" title={currentProject}>
      <button type="button" className="project-chip-name" onClick={() => window.petAPI.agentOpenFolder('project')} title={`${currentProject}\n${t('点一下在资源管理器里打开')}`}>📁 {projectLabel(currentProject)}</button>
      <button type="button" className="project-chip-btn" onClick={() => void chooseProject(false)} disabled={busy} title={t('换一个项目文件夹')}>{t('换')}</button>
      <button type="button" className="project-chip-btn" onClick={() => void unbindProject()} disabled={busy} title={t('这个对话不再绑定项目文件夹')}>✕</button>
    </span>
  ) : null;
  const uiMode = settings.uiMode;
  const p = settings.profile;
  const me = p.displayName || p.callMe || t('我');

  const pageControls = (
    <button type="button" className="page-close" onClick={() => setPage('chat')} title={t('关闭，回到会话（Esc）')}>✕</button>
  );
  const row = (s: SessionSummary, markPinned: boolean): JSX.Element => {
    const locked = busy && s.id !== session?.id;
    return (
      <div
        key={s.id} role="button" tabIndex={0} aria-disabled={locked}
        className={`hx-session${s.id === session?.id ? ' current' : ''}${locked ? ' locked' : ''}`}
        onClick={() => { if (!locked) openSession(s.id); }}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && !locked) { e.preventDefault(); openSession(s.id); } }}
        title={`${s.title}${s.project ? `\n📁 ${s.project}` : ''}`}
      >
        <span className="hx-session-main">
          <span className="hx-session-title">{markPinned && s.pinned ? '📌 ' : ''}{t(s.title)}</span>
        </span>
        <span className="hx-session-time">{shortDate(s.updatedAt)}</span>
        <span className="hx-session-actions">
          <button type="button" title={t('重命名会话')} onClick={e => { e.stopPropagation(); setNaming({ kind: 'session', id: s.id }); setNameInput(s.title); }}>✎</button>
          <button type="button" className={s.pinned ? 'on' : ''} title={s.pinned ? t('取消置顶') : t('置顶')} onClick={(e) => { e.stopPropagation(); void togglePin(s); }}>📌</button>
          <button type="button" title={t('删除这个会话')} disabled={busy && s.id === session?.id} onClick={(e) => { e.stopPropagation(); void removeSession(s); }}>🗑</button>
        </span>
      </div>
    );
  };

  return (
    <div className={`app${panel.fullscreen ? ' is-full' : ''}`}>
      <aside className="nav">
        <div className="nav-brand">
          {avatar ? <img src={avatar} alt="" className="hx-avatar" /> : <span className="hx-avatar" />}
          <span className="nav-brand-name">{name}</span>
          {busy && <span className="nav-busy" title={t('她正在做事')}>●</span>}
          <span className="nav-switch" role="tablist" aria-label={t('聊天 / 代码')}>
            <button type="button" role="tab" aria-selected={navMode === 'chat'} className={navMode === 'chat' ? 'on' : ''} onClick={() => setNavMode('chat')} title={t('聊天：普通会话')}><ChatIcon /></button>
            <button type="button" role="tab" aria-selected={navMode === 'code'} className={navMode === 'code' ? 'on' : ''} onClick={() => setNavMode('code')} title={t('代码：项目和项目里的对话')}><CodeIcon /></button>
          </span>
          <button type="button" className="nav-collapse" onClick={toggleNav} title={t('收起侧边栏（Ctrl+B）')} aria-label={t('收起侧边栏（Ctrl+B）')}><SidebarIcon /></button>
        </div>
        {navMode === 'chat' && (
          <button type="button" className="nav-new" onClick={newSession} disabled={busy} title={busy ? t('她正在做事，做完再开新会话') : t('开始新会话（Ctrl+N，/new）')}>{t('＋ 新会话')}</button>
        )}
        {navMode === 'code' && <button type="button" className="nav-new" disabled={busy} onClick={() => { setNaming({ kind: 'group' }); setNameInput(''); }}>{t('＋ 创建项目组')}</button>}
        {naming && <form className="nav-name-form" onSubmit={async e => {
          e.preventDefault();
          const value = nameInput.trim();
          if (!value || savingName.current) return;
          savingName.current = true;
          try {
            if (naming.kind === 'session') {
              if (!report(await window.petAPI.sessionRename(naming.id, value))) return;
            } else {
              const folder = await window.petAPI.agentPickFolder();
              if (!folder || !report(await window.petAPI.sessionProject(folder, true))) return;
              const next = { ...namedProjects, [folder]: value };
              save('nav.namedProjects', next);
              setNamedProjects(next);
              setPage('chat');
              setNavMode('code');
              setFolded(f => { const open = f.filter(k => k !== 'all:code' && k !== 'p:' + folder); save('nav.folded', open); return open; });
            }
            setNaming(null);
            refreshSessions();
          } finally { savingName.current = false; }
        }}>
          <label>{naming.kind === 'group' ? t('项目组名称') : t('会话名称')}
            <input autoFocus maxLength={80} value={nameInput} onChange={e => setNameInput(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} />
          </label>
          <div><button type="submit" disabled={!nameInput.trim()}>{naming.kind === 'group' ? t('选择工作文件夹') : t('保存')}</button>
          <button type="button" onClick={() => setNaming(null)}>{t('取消')}</button></div>
        </form>}
        <div className="nav-group nav-main">
          <button type="button" className="nav-fold-all" onClick={() => toggleFold(`all:${navMode}`)} title={isFolded(`all:${navMode}`) ? t('展开') : t('折叠全部')}>
            <Caret open={!isFolded(`all:${navMode}`)} />
            <span>{navMode === 'chat' ? t('会话') : t('项目')}</span>
            <small>{navMode === 'chat' ? chats.length : projects.size}</small>
          </button>
          <div className="nav-sessions">
            {!isFolded(`all:${navMode}`) && navMode === 'chat' && [...groups].map(([label, list]) => (
              <section key={label}>
                <h4 className="fold-head" role="button" tabIndex={0} onClick={() => toggleFold(`g:${label}`)} onKeyDown={(e) => { if (e.key === 'Enter') toggleFold(`g:${label}`); }}>
                  <Caret open={!isFolded(`g:${label}`)} />{t(label)}<small>{list.length}</small>
                </h4>
                {!isFolded(`g:${label}`) && list.map((s) => row(s, false))}
              </section>
            ))}
            {!isFolded(`all:${navMode}`) && navMode === 'chat' && chats.length === 0 && <p className="hx-side-empty">{t('还没有会话')}</p>}
            {!isFolded(`all:${navMode}`) && navMode === 'code' && [...projects].map(([folder, list]) => (
              <section key={folder} className="nav-project">
                <div className={`nav-project-head${list.some((s) => s.current) ? ' current' : ''}`} title={folder}>
                  <button type="button" className="nav-project-name" onClick={() => toggleFold(`p:${folder}`)}>
                    <Caret open={!isFolded(`p:${folder}`)} /><span className="nav-project-icon">📁</span><span className="nav-project-label">{projectLabel(folder)}</span>
                  </button>
                  <button type="button" className="nav-project-add" onClick={() => void newThread(folder)} disabled={busy} title={t('在这个项目里开一个新对话（新分支）')}>＋</button>
                </div>
                {!isFolded(`p:${folder}`) && <div className="nav-project-threads">{list.map((s) => row(s, true))}</div>}
              </section>
            ))}
            {!isFolded(`all:${navMode}`) && navMode === 'code' && projects.size === 0 && <p className="hx-side-empty">{t('点击「创建项目组」，选择工作文件夹即可开始。')}</p>}
          </div>
        </div>
        {update.ready && (
          <button type="button" className="nav-update" onClick={installUpdate} disabled={installing} title={t('安装新版本，桌宠会自动重启（几秒钟）')}>
            {installing ? t('正在更新，马上回来…') : t('⬆ 有新版本 · 点此更新')}
          </button>
        )}
        <div className="nav-foot" ref={menuRef} data-open={menu ? '1' : '0'}>
          {menu && (
            <div className="me-menu" role="menu">
              <button type="button" role="menuitem" className={page === 'schedules' ? 'on' : ''} onClick={() => go('schedules')}><span className="nav-icon">⏰</span>{t('定时任务')}</button>
              <button type="button" role="menuitem" className={page === 'skills' ? 'on' : ''} onClick={() => go('skills')}><span className="nav-icon">🧩</span>{t('技能')}</button>
              <hr />
              <button type="button" role="menuitem" className={page === 'profile' ? 'on' : ''} onClick={() => go('profile')}><span className="nav-icon">👤</span>{t('我的资料')}</button>
              <button type="button" role="menuitem" className={page === 'settings' ? 'on' : ''} onClick={() => go('settings')}><span className="nav-icon">⚙</span>{t('设置')}<kbd>Ctrl+,</kbd></button>
            </div>
          )}
          <button type="button" className={`nav-me${menu || page !== 'chat' ? ' on' : ''}`} onClick={() => setMenu((m) => !m)} title={t('定时任务、技能、我的资料、设置')} aria-haspopup="menu" aria-expanded={menu}>
            {userAvatar ? <img src={userAvatar} alt="" className="hx-avatar small" /> : <span className="hx-avatar small hx-avatar-letter">{me.slice(0, 1)}</span>}
            <span className="nav-me-name">{me}</span><span className="nav-me-caret">{menu ? '▾' : '▴'}</span>
          </button>
          <button
            type="button" className="nav-mode" title={t('外观：{now}（点一下切换到{next}）', { now: t(UI_LABEL[uiMode]), next: t(UI_LABEL[UI_NEXT[uiMode]]) })}
            onClick={() => void useSettingsStore.getState().update({ uiMode: UI_NEXT[uiMode] })}
          >{UI_ICON[uiMode]}</button>
        </div>
      </aside>

      <main className={`content${browser.open && page === 'chat' ? ' with-pane' : ''}`}>
        <div className="content-main">
        <ChatView sessionTitle={sessions.find(s => s.id === session?.id)?.title} active={page === 'chat'} avatar={avatar} userAvatar={userAvatar} onWanted={() => setPage('chat')} project={<>{navMode === 'code' ? null : projectChip}{browserToggle}</>} codeMode={navMode === 'code'} composerTop={codeStrip} projectName={currentProject ? projectLabel(currentProject) : null} />
        {page === 'schedules' && <SchedulesPage controls={pageControls} />}
        {page === 'skills' && <SkillsPage controls={pageControls} />}
        {page === 'profile' && <ProfilePage controls={pageControls} userAvatar={userAvatar} onAvatar={setUserAvatar} />}
        {page === 'settings' && <SettingsPage controls={pageControls} />}
        </div>
        {browser.open && page === 'chat' && <BrowserPane state={browser} width={browserWidth} onWidth={setBrowserWidth} />}
      </main>
    </div>
  );
}

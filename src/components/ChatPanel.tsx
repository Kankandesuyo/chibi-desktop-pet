import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { SessionSummary } from '../../shared/harness';
import { withAttachments, type ChatCompose } from '../../shared/fileDrop';
import type { PanelAction, PanelState, Settings } from '../../shared/types';
import { useChatStore, type ChatMode } from '../store/chatStore';
import { usePetStore } from '../store/petStore';
import { useSettingsStore } from '../store/settingsStore';
import { Composer, type PermissionMode } from './chat/Composer';
import { Sidebar } from './chat/Sidebar';
import { StatsBar } from './chat/StatsBar';
import { PermissionCard, PlanBox, ToolRows } from './chat/ToolRows';
import { Trajectory } from './chat/Trajectory';

function modeOf(s: Settings): ChatMode {
  return !(s.aiEnabled && s.ai.hasApiKey) ? 'offline' : s.agent.enabled ? 'agent' : 'chat';
}

const permissionOf = (s: Settings): PermissionMode => (s.agent.readOnly ? 'readonly' : s.agent.autoApproveMedium ? 'auto' : 'ask');

/** Below this width the session column folds away (the smallest window size). */
const SIDEBAR_MIN_WIDTH = 640;

/**
 * The chat window, laid out like an agent harness: sessions on the left; the conversation with each tool
 * call as an expandable row, inline permission prompts and the plan; a trajectory tab with the raw event
 * log; a composer with slash commands and the permission mode; run stats at the bottom. She is still she:
 * her name, face, colours and voice.
 */
export function ChatPanel(): JSX.Element {
  const { messages, streaming, requestId, notice, steps, plan, interim, confirms, send, stop, clear, answer, session } = useChatStore();
  const settings = useSettingsStore((s) => s.settings);
  const [text, setText] = useState('');
  const [panel, setPanel] = useState<PanelState>({ pinned: false, sizeIndex: 1, sizeCount: 4 });
  const control = (a: PanelAction): void => { void window.petAPI.panelControl(a).then((s) => { if (s) setPanel(s); }); };
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Files dropped on her that the next message is about (shown as a chip, appended on send). */
  const [attached, setAttached] = useState<string[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  /** Answer to the last slash command (shown in the list, never sent to the model). */
  const [commandReply, setCommandReply] = useState<string | null>(null);
  const [tab, setTab] = useState<'chat' | 'trajectory'>('chat');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [avatar, setAvatar] = useState('');
  const [wide, setWide] = useState(() => window.innerWidth >= SIDEBAR_MIN_WIDTH);
  const [sideOpen, setSideOpen] = useState(true);
  const mode: ChatMode = modeOf(settings);
  const working = requestId !== null;
  const name = settings.petName || '她';

  const refreshSessions = useCallback((): void => {
    void window.petAPI.sessionsList().then((r) => { if (!('error' in r)) setSessions(r.sessions); });
  }, []);

  useEffect(() => {
    const applyCompose = (c: ChatCompose | null): void => {
      if (!c || c.paths.length === 0) return;
      const chat = useChatStore.getState();
      if (c.prompt && modeOf(useSettingsStore.getState().settings) === 'agent' && !chat.requestId) {
        chat.send(c.prompt, 'agent', usePetStore.getState().stats);
        return;
      }
      // Needs the user's words (or she is busy / agent mode is off): attach and let them type.
      setAttached(c.paths);
      setHint(c.prompt ? (chat.requestId ? '她还在忙上一个任务，等她做完再发' : '要先在设置里打开 AI 和智能体模式') : c.hint ?? null);
      inputRef.current?.focus();
    };
    const takeCompose = (): void => { void window.petAPI.takeChatCompose().then(applyCompose); };
    void window.petAPI.getInitialData().then(async (d) => {
      useSettingsStore.getState().apply(d.settings);
      usePetStore.getState().setStats(d.stats);
      if (window.petAPI.sharedState) useChatStore.getState().sync(await window.petAPI.sharedState());
      else useChatStore.getState().load(d.chatHistory);
      takeCompose();                                          // only after the history is in, or it would be overwritten
    });
    const offCompose = window.petAPI.onChatCompose(takeCompose);
    const offFocus = window.petAPI.onChatFocus(() => inputRef.current?.focus());
    const offShared = window.petAPI.onSharedChat?.((s) => useChatStore.getState().sync(s));
    const offStream = window.petAPI.onAiStream((e) => useChatStore.getState().handleStream(e));
    const offAgent = window.petAPI.onAgentEvent((e) => useChatStore.getState().handleAgent(e));
    const offSettings = window.petAPI.onSettings((s) => {
      const characterChanged = s.character !== useSettingsStore.getState().settings.character;
      useSettingsStore.getState().apply(s);
      if (characterChanged) void window.petAPI.petAvatar().then(setAvatar);
    });
    void window.petAPI.panelControl('state').then((s) => { if (s) setPanel(s); });
    void window.petAPI.petAvatar().then(setAvatar);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement && e.target.value.startsWith('/'))) window.petAPI.closePanel(); };
    const onResize = (): void => setWide(window.innerWidth >= SIDEBAR_MIN_WIDTH);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { offCompose(); offFocus(); offShared?.(); offStream(); offAgent(); offSettings(); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, []);

  // The list changes when the session changes, and a new session gets its title from its first message.
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  useEffect(() => { refreshSessions(); }, [session?.id, firstUser, refreshSessions]);

  useEffect(() => {
    if (tab === 'chat') listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming, steps, confirms, plan, commandReply, tab]);

  const sendNow = (t: string): void => send(t, mode, usePetStore.getState().stats);

  const submit = (): void => {
    if (!text.trim()) return;
    if (/^\/\S/.test(text.trim()) && attached.length === 0) {
      // Slash command: answered by the main process, no model turn. Unknown "/…" text falls through as a message.
      const typed = text;
      setText('');
      void window.petAPI.agentCommand(typed).then((r) => {
        if (!r) { if (!useChatStore.getState().requestId) sendNow(typed); return; }
        // In the shared conversation /new has already switched session in the main process.
        if (r.action === 'clear' && !window.petAPI.sharedClear) clear();
        setCommandReply(r.reply);
        if (r.action === 'send' && r.prompt) sendNow(r.prompt);
      });
      return;
    }
    if (working) return;
    setCommandReply(null);
    sendNow(withAttachments(text, attached));
    setText('');
    setAttached([]);
    setHint(null);
  };

  const openSession = (id: string): void => {
    setCommandReply(null);
    void window.petAPI.sessionOpen(id).then((r) => { if ('error' in r) useChatStore.setState({ notice: r.error }); refreshSessions(); });
  };
  const newSession = (): void => {
    setCommandReply(null);
    if (window.petAPI.sharedClear) void window.petAPI.sessionNew().then((r) => { if ('error' in r) useChatStore.setState({ notice: r.error }); refreshSessions(); });
    else clear();
  };
  const setPermission = (m: PermissionMode): void => {
    void window.petAPI.agentUpdateSettings({ readOnly: m === 'readonly', autoApproveMedium: m === 'auto' }).then((s) => useSettingsStore.getState().apply(s));
  };

  const badge = mode === 'offline' ? '离线' : mode === 'agent' ? '智能体' : '聊天';
  const showSide = wide && sideOpen;
  const liveSteps = steps.filter((s) => s.tool !== 'update_plan');
  const placeholder = hint ?? (mode === 'agent' ? `和${name}说点什么，或让她帮你做事…` : mode === 'chat' ? `和${name}说点什么…` : '输入消息，回车发送');

  return (
    <div className={`hx${showSide ? ' with-side' : ''}`}>
      {showSide && (
        <Sidebar
          sessions={sessions} current={session?.id ?? null} busy={working} name={name} avatar={avatar}
          onOpen={openSession} onNew={newSession} onSettings={() => window.petAPI.openSettings()}
        />
      )}
      <main className="hx-main">
        <header className="hx-head">
          {wide && <button type="button" className="hx-icon" onClick={() => setSideOpen(!sideOpen)} title={sideOpen ? '收起会话列表' : '展开会话列表'}>☰</button>}
          {avatar && <img src={avatar} alt="" className="hx-avatar small" />}
          <span className="hx-title">{name}</span>
          {wide && <span className={`hx-badge b-${mode}`}>{badge}</span>}
          <nav className="hx-tabs">
            <button type="button" className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>对话</button>
            <button type="button" className={tab === 'trajectory' ? 'on' : ''} onClick={() => setTab('trajectory')} title="每一次模型请求和工具调用的原始记录">轨迹</button>
          </nav>
          <span className="hx-head-actions">
            {!showSide && <button type="button" className="hx-icon" onClick={newSession} disabled={working} title="新会话（/new）">✎</button>}
            <button type="button" className={`hx-icon${panel.pinned ? ' on' : ''}`} onClick={() => control('toggle-pin')} title={panel.pinned ? '已置顶：点一下取消置顶' : '点一下让窗口始终在最前面'}>📌</button>
            <button type="button" className="hx-icon" onClick={() => control('smaller')} disabled={panel.sizeIndex <= 0} title="缩小窗口">－</button>
            <button type="button" className="hx-icon" onClick={() => control('bigger')} disabled={panel.sizeIndex >= panel.sizeCount - 1} title="放大窗口">＋</button>
            {!showSide && <button type="button" className="hx-icon" onClick={() => window.petAPI.openSettings()} title="设置">⚙</button>}
            <button type="button" className="hx-icon" onClick={() => control('hide')} title="暂时关闭（聊天记录和正在进行的任务都会保留；双击桌宠重新打开，需要确认时会自动弹出）">✕</button>
          </span>
        </header>

        {tab === 'trajectory' ? (
          <div className="hx-scroll"><Trajectory refreshKey={`${session?.id ?? ''}:${messages.length}:${working}`} /></div>
        ) : (
          <div className="hx-scroll" ref={listRef}>
            <div className="hx-thread">
              {messages.length === 0 && !working && (
                <div className="hx-welcome">
                  {avatar && <img src={avatar} alt="" />}
                  <p>
                    {mode === 'offline' && '还没有配置 AI：现在是离线模式，她只会说几句简单的话。在“设置”里填好 API 就能真正聊天。'}
                    {mode === 'chat' && `和${name}说点什么吧～`}
                    {mode === 'agent' && `说点什么，或者让${name}帮你做事：\n“在桌面建一个叫 AI项目 的文件夹”\n“打开 VS Code”\n“帮我找昨天下载的 PDF”\n有风险的操作会先问你。输入 / 可以用命令。`}
                  </p>
                </div>
              )}
              {messages.map((m, i) => (
                m.role === 'user'
                  ? <div key={i} className="hx-msg hx-user">{m.content}</div>
                  : (
                    <div key={i} className={`hx-msg hx-assistant${m.outcome === 'failure' || (m as { failed?: boolean }).failed ? ' failed' : ''}`}>
                      {avatar ? <img src={avatar} alt="" className="hx-avatar small" /> : <span className="hx-avatar small" />}
                      <div className="hx-assistant-body">
                        {m.steps && m.steps.length > 0 && <ToolRows steps={m.steps} />}
                        <div className="hx-text">{m.content}</div>
                      </div>
                    </div>
                  )
              ))}
              {working && (
                <div className="hx-msg hx-assistant live">
                  {avatar ? <img src={avatar} alt="" className="hx-avatar small" /> : <span className="hx-avatar small" />}
                  <div className="hx-assistant-body">
                    <PlanBox plan={plan} />
                    {interim.map((t, i) => <p key={i} className="hx-interim">{t}</p>)}
                    {liveSteps.length > 0 && <ToolRows steps={liveSteps} />}
                    {confirms.map((c) => <PermissionCard key={c.confirmId} req={c} answer={answer} onEdit={(p) => setText(p)} />)}
                    {streaming !== null && (streaming ? <div className="hx-text">{streaming}</div> : confirms.length === 0 && <div className="hx-thinking"><span /><span /><span /></div>)}
                  </div>
                </div>
              )}
              {commandReply && <pre className="hx-command">{commandReply}</pre>}
              {notice && <p className="hx-notice">{notice}</p>}
            </div>
          </div>
        )}

        <Composer
          text={text} setText={setText} onSubmit={submit} working={working} onStop={stop} placeholder={placeholder}
          inputRef={inputRef} attached={attached} onClearAttached={() => { setAttached([]); setHint(null); }}
          permission={mode === 'agent' ? permissionOf(settings) : null} onPermission={setPermission}
        />
        <StatsBar sessionId={session?.id ?? null} stats={session?.stats ?? null} working={working} />
      </main>
      <div
        className="resize-grip"
        title="拖动调节窗口大小"
        onPointerDown={(e) => {
          e.preventDefault();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* window listeners below still work */ }
          const start = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight };
          let raf = 0;
          const move = (ev: PointerEvent): void => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => window.petAPI.panelResize(start.w + ev.screenX - start.x, start.h + ev.screenY - start.y));
          };
          const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />
    </div>
  );
}

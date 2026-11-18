import { WelcomeGreeting } from './WelcomeGreeting';
import { WelcomeAvatar } from "./WelcomeAvatar";
import { useEffect, useRef, useState, type JSX } from 'react';
import { withAttachments, type ChatCompose } from '../../shared/fileDrop';
import type { Settings } from '../../shared/types';
import { useChatStore, type ChatMode } from '../store/chatStore';
import { usePetStore } from '../store/petStore';
import { useSettingsStore } from '../store/settingsStore';
import { Composer, type PermissionMode } from './chat/Composer';
import { StatsBar } from './chat/StatsBar';
import { PermissionCard, PlanBox, ToolRows } from './chat/ToolRows';
import { Trajectory } from './chat/Trajectory';
import { useT } from '../i18n';

export function modeOf(s: Settings): ChatMode {
  return !(s.aiEnabled && s.ai.hasApiKey) ? 'offline' : s.agent.enabled ? 'agent' : 'chat';
}

const permissionOf = (s: Settings): PermissionMode => (s.agent.readOnly ? 'readonly' : s.agent.autoApproveMedium ? 'auto' : 'ask');

interface Props {
  /** This page is the one shown (it stays mounted, hidden, while another page is open). */
  active: boolean;
  sessionTitle?: string;
  avatar: string;
  userAvatar: string;
  /** Something asked for the chat (dropped files, the hotkey): show this page. */
  onWanted(): void;
  /** The project folder chip (when this conversation works in one). */
  project?: JSX.Element | null;
  /** The sidebar is in the code view: a code-style empty state and the project strip above the input. */
  codeMode?: boolean;
  composerTop?: JSX.Element | null;
  projectName?: string | null;
}

/**
 * The conversation page, laid out like an agent harness: each tool call as an expandable row, inline
 * permission prompts and the plan; a trajectory tab with the raw event log; a composer with slash
 * commands and the permission mode; run stats and the context-window meter at the bottom.
 */
export function ChatView({ sessionTitle, active, avatar, userAvatar, onWanted, project, codeMode = false, composerTop = null, projectName = null }: Props): JSX.Element {
  const { messages, streaming, requestId, notice, steps, plan, interim, confirms, send, stop, clear, answer, session } = useChatStore();
  const settings = useSettingsStore((s) => s.settings);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Files dropped on her that the next message is about (shown as a chip, appended on send). */
  const [attached, setAttached] = useState<string[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  /** Answer to the last slash command (shown in the list, never sent to the model). */
  const [commandReply, setCommandReply] = useState<string | null>(null);
  const [tab, setTab] = useState<'chat' | 'trajectory'>('chat');
  const mode: ChatMode = modeOf(settings);
  const working = requestId !== null;
  const t = useT();
  const name = settings.petName || t('她');
  const wantedRef = useRef(onWanted);
  wantedRef.current = onWanted;

  useEffect(() => {
    const applyCompose = (c: ChatCompose | null): void => {
      if (!c || c.paths.length === 0) return;
      wantedRef.current();
      const chat = useChatStore.getState();
      if (c.prompt && modeOf(useSettingsStore.getState().settings) === 'agent' && !chat.requestId) {
        chat.send(c.prompt, 'agent', usePetStore.getState().stats);
        return;
      }
      // Needs the user's words (or she is busy / agent mode is off): attach and let them type.
      setAttached(c.paths);
      setHint(c.prompt ? (chat.requestId ? t('她还在忙上一个任务，等她做完再发') : t('要先在设置里打开 AI 和智能体模式')) : c.hint ? t(c.hint) : null);
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
    const offFocus = window.petAPI.onChatFocus(() => { wantedRef.current(); window.setTimeout(() => inputRef.current?.focus(), 0); });
    const offShared = window.petAPI.onSharedChat?.((s) => useChatStore.getState().sync(s));
    const offStream = window.petAPI.onAiStream((e) => useChatStore.getState().handleStream(e));
    const offAgent = window.petAPI.onAgentEvent((e) => {
      if (e.type === 'confirm') wantedRef.current();          // a question for the user: show it
      useChatStore.getState().handleAgent(e);
    });
    return () => { offCompose(); offFocus(); offShared?.(); offStream(); offAgent(); };
  }, []);

  useEffect(() => {
    if (active && tab === 'chat') listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming, steps, confirms, plan, commandReply, tab, active]);
  useEffect(() => { if (active) inputRef.current?.focus(); }, [active]);

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

  // A new session clears the last command answer.
  useEffect(() => { setCommandReply(null); }, [session?.id]);

  const setPermission = (m: PermissionMode): void => {
    void window.petAPI.agentUpdateSettings({ readOnly: m === 'readonly', autoApproveMedium: m === 'auto' }).then((s) => useSettingsStore.getState().apply(s));
  };

  const badge = mode === 'offline' ? t('离线') : mode === 'agent' ? t('智能体') : t('聊天');
  const liveSteps = steps.filter((s) => s.tool !== 'update_plan');
  const placeholder = hint ?? (mode === 'agent' ? t('和{name}说点什么，或让她帮你做事…（输入 / 用命令）', { name }) : mode === 'chat' ? t('和{name}说点什么…', { name }) : t('输入消息，回车发送'));
  const firstUser = messages.find((m) => m.role === 'user')?.content.split('\n')[0] ?? '';
  const title = sessionTitle ? t(sessionTitle) : (firstUser ? firstUser.slice(0, 60) : t('新会话'));  // t(): the untitled default comes from the main process in Chinese
  const userFace = userAvatar
    ? <img src={userAvatar} alt="" className="hx-avatar small" />
    : <span className="hx-avatar small hx-avatar-letter">{(settings.profile.displayName || settings.profile.callMe || t('我')).slice(0, 1)}</span>;

  return (
    <section className="page page-chat" hidden={!active}>
      <header className="page-head">
        <span className="page-title" title={title}>{title}</span>
        <span className={`hx-badge b-${mode}`}>{badge}</span>
        {project}
        <nav className="hx-tabs">
          <button type="button" className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>{t('对话')}</button>
          <button type="button" className={tab === 'trajectory' ? 'on' : ''} onClick={() => setTab('trajectory')} title={t('每一次模型请求和工具调用的原始记录')}>{t('轨迹')}</button>
        </nav>
      </header>

      {tab === 'trajectory' ? (
        <div className="hx-scroll"><Trajectory refreshKey={`${session?.id ?? ''}:${messages.length}:${working}`} /></div>
      ) : (
        <div className="hx-scroll" ref={listRef}>
          <div className="hx-thread">
            {messages.length === 0 && !working && (
              <div className="hx-welcome code" lang={settings.language}>
                <WelcomeAvatar key={settings.character + avatar} character={settings.character} avatar={avatar} name={name} t={t} />
                <WelcomeGreeting callMe={settings.profile.callMe} displayName={settings.profile.displayName} />
                {codeMode && projectName && <p>{t('{name}会在这个项目文件夹里读代码、改代码；删除文件和运行命令会先问你。', { name })}</p>}
                {!codeMode && mode === 'offline' && <p>{t('还没有配置 AI：现在是离线模式，她只会说几句简单的话。在“设置 → AI 聊天”里填好 API 就能真正聊天。')}</p>}
                {!codeMode && mode === 'agent' && (
                  <div className="hx-suggest">
                    {[t('在桌面建一个叫 AI项目 的文件夹'), t('帮我找昨天下载的 PDF'), t('看看我的电脑现在卡不卡'), t('每天早上 9 点帮我看看下载文件夹')].map((s) => (
                      <button key={s} type="button" onClick={() => { setText(s); inputRef.current?.focus(); }}>{s}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {messages.map((m, i) => (
              m.role === 'user'
                ? <div key={i} className="hx-msg hx-user-row"><div className="hx-user">{m.content}</div>{userFace}</div>
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

      <div className="hx-bottom">
        {composerTop}
        <Composer
          text={text} setText={setText} onSubmit={submit} working={working} onStop={stop} placeholder={placeholder}
          inputRef={inputRef} attached={attached} onClearAttached={() => { setAttached([]); setHint(null); }}
          permission={mode === 'agent' ? permissionOf(settings) : null} onPermission={setPermission}
        />
        <StatsBar sessionId={session?.id ?? null} stats={session?.stats ?? null} working={working} contextWindow={settings.agent.contextWindow} />
      </div>
    </section>
  );
}

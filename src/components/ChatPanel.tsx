import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import type { AgentStepView, ConfirmRequest, PlanStepView } from '../../shared/agentTypes';
import type { PanelAction, PanelState } from '../../shared/types';
import { useChatStore, type ChatMode } from '../store/chatStore';
import { usePetStore } from '../store/petStore';
import { useSettingsStore } from '../store/settingsStore';

const STEP_ICON: Record<AgentStepView['status'], string> = { running: '⏳', waiting: '⏸', ok: '✅', failed: '❌', denied: '🚫' };
const PLAN_ICON: Record<PlanStepView['status'], string> = { pending: '○', in_progress: '▶', done: '✔', failed: '✘', skipped: '–' };
const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' } as const;

function Steps({ steps }: { steps: AgentStepView[] }): JSX.Element {
  return (
    <ul className="agent-steps">
      {steps.map((s) => (
        <li key={s.stepId} className={`step-${s.status}`}>
          <span className="step-icon">{STEP_ICON[s.status]}</span>
          <span className="step-text">{s.title}{s.summary && s.status !== 'running' ? <small>{s.summary}</small> : null}</span>
        </li>
      ))}
    </ul>
  );
}

function ConfirmCard({ req, onEdit }: { req: ConfirmRequest; onEdit: (prefix: string) => void }): JSX.Element {
  const answer = useChatStore((s) => s.answer);
  /** Something about to be posted under the user's account: offer "改一下" next to 发 / 不发. */
  const publish = req.tool === 'browser_click' && req.risk === 'high';
  return (
    <div className={`confirm confirm-${req.risk}`}>
      <div className="confirm-head"><b>{req.title}</b><span className="badge">{RISK_LABEL[req.risk]}</span></div>
      <p className="confirm-reason">{req.reason}</p>
      {req.afterExternalContent && <p className="confirm-warn">⚠ 这一步是在读取了文件/网页等外部内容之后提出的，请确认这确实是你想要的。</p>}
      {req.preview.length > 0 && <pre className="confirm-preview">{req.preview.join('\n')}</pre>}
      <div className="confirm-actions">
        <button type="button" className="ok" onClick={() => answer(req.confirmId, 'allow')}>{publish ? '发' : '允许'}</button>
        {publish && <button type="button" onClick={() => { answer(req.confirmId, 'deny'); onEdit('先别发，改成：'); }}>改一下</button>}
        {req.canAllowForTask && <button type="button" onClick={() => answer(req.confirmId, 'allow_task')}>本次任务都允许</button>}
        <button type="button" className="no" onClick={() => answer(req.confirmId, 'deny')}>{publish ? '不发' : '拒绝'}</button>
      </div>
    </div>
  );
}

/** Chat window. In agent mode it also shows the plan, each tool step and confirmation cards. */
export function ChatPanel(): JSX.Element {
  const { messages, streaming, requestId, notice, steps, plan, interim, confirms, send, stop, clear } = useChatStore();
  const settings = useSettingsStore((s) => s.settings);
  const [text, setText] = useState('');
  const [panel, setPanel] = useState<PanelState>({ pinned: false, sizeIndex: 1, sizeCount: 4 });
  const control = (a: PanelAction): void => { void window.petAPI.panelControl(a).then((s) => { if (s) setPanel(s); }); };
  const listRef = useRef<HTMLDivElement>(null);
  const aiReady = settings.aiEnabled && settings.ai.hasApiKey;
  const mode: ChatMode = !aiReady ? 'offline' : settings.agent.enabled ? 'agent' : 'chat';

  useEffect(() => {
    void window.petAPI.getInitialData().then((d) => {
      useSettingsStore.getState().apply(d.settings);
      usePetStore.getState().setStats(d.stats);
      if (window.petAPI.sharedState) void window.petAPI.sharedState().then((s) => useChatStore.getState().sync(s));
      else useChatStore.getState().load(d.chatHistory);
    });
    const offShared = window.petAPI.onSharedChat?.((s) => useChatStore.getState().sync(s));
    const offStream = window.petAPI.onAiStream((e) => useChatStore.getState().handleStream(e));
    const offAgent = window.petAPI.onAgentEvent((e) => useChatStore.getState().handleAgent(e));
    const offSettings = window.petAPI.onSettings((s) => useSettingsStore.getState().apply(s));
    void window.petAPI.panelControl('state').then((s) => { if (s) setPanel(s); });
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') window.petAPI.closePanel(); };
    window.addEventListener('keydown', onKey);
    return () => { offShared?.(); offStream(); offAgent(); offSettings(); window.removeEventListener('keydown', onKey); };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming, steps, confirms, plan]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    send(text, mode, usePetStore.getState().stats);
    setText('');
  };

  const title = mode === 'offline' ? '和她聊天（离线模式）' : mode === 'agent' ? '和她聊天 · 智能体模式' : '和她聊天';
  const working = requestId !== null;

  return (
    <div className="chat">
      <header className="chat-head">
        <span>{title}</span>
        <span className="chat-head-actions">
          <button type="button" className={panel.pinned ? 'on' : ''} onClick={() => control('toggle-pin')} title={panel.pinned ? '已置顶：点一下取消置顶' : '点一下让窗口始终在最前面'}>📌</button>
          <button type="button" onClick={() => control('smaller')} disabled={panel.sizeIndex <= 0} title="缩小窗口">－</button>
          <button type="button" onClick={() => control('bigger')} disabled={panel.sizeIndex >= panel.sizeCount - 1} title="放大窗口">＋</button>
          <button type="button" onClick={clear} title="清除聊天记录">清空</button>
          <button type="button" onClick={() => window.petAPI.openSettings()} title="设置">设置</button>
          <button type="button" onClick={() => control('hide')} title="暂时关闭（聊天记录和正在进行的任务都会保留；双击桌宠重新打开，需要确认时会自动弹出）">✕</button>
        </span>
      </header>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && !working && (
          <p className="chat-empty">
            {mode === 'offline' && '还没有配置 AI：现在是离线模式，她只会说几句简单的话。在“设置”里填好 API 就能真正聊天。'}
            {mode === 'chat' && '说点什么吧～'}
            {mode === 'agent' && '说点什么，或者让她帮你做事：\n“在桌面建一个叫 AI项目 的文件夹”\n“打开 VS Code”\n“帮我找昨天下载的 PDF”\n有风险的操作会先问你。'}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}${m.outcome === 'failure' ? ' chat-failed' : ''}`}>
            {m.steps && m.steps.length > 0 && (
              <details className="agent-done-steps">
                <summary>{m.outcome === 'failure' ? '⚠ ' : ''}执行了 {m.steps.length} 步</summary>
                <Steps steps={m.steps} />
              </details>
            )}
            {m.content}
          </div>
        ))}
        {working && (plan.length > 0 || steps.length > 0 || interim.length > 0) && (
          <div className="agent-live">
            {plan.length > 0 && (
              <ol className="agent-plan">
                {plan.map((p, i) => <li key={i} className={`plan-${p.status}`}><span>{PLAN_ICON[p.status]}</span>{p.title}</li>)}
              </ol>
            )}
            {interim.map((t, i) => <p key={i} className="agent-interim">{t}</p>)}
            {steps.filter((s) => s.tool !== 'update_plan').length > 0 && <Steps steps={steps.filter((s) => s.tool !== 'update_plan')} />}
          </div>
        )}
        {confirms.map((c) => <ConfirmCard key={c.confirmId} req={c} onEdit={(p) => setText(p)} />)}
        {streaming !== null && (streaming || confirms.length === 0) && <div className="chat-msg chat-assistant">{streaming || '…'}</div>}
        {notice && <p className="chat-notice">{notice}</p>}
      </div>
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
      <form className="chat-form" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === 'agent' ? '聊天，或让她帮你做事…' : '输入消息，回车发送'} maxLength={1000} autoFocus />
        {working ? <button type="button" onClick={stop}>停止</button> : <button type="submit" disabled={!text.trim()}>发送</button>}
      </form>
    </div>
  );
}

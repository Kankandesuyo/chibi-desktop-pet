import { useState, type JSX } from 'react';
import type { AgentStepView, ConfirmDecision, ConfirmRequest, PlanStepView } from '../../../shared/agentTypes';
import { useT } from '../../i18n';

const STATUS_LABEL: Record<AgentStepView['status'], string> = { running: '进行中', waiting: '等待确认', ok: '完成', failed: '失败', denied: '未执行' };

/** One tool call: a single row (status · tool name · what it did), expanding in place for the details. */
function ToolRow({ step }: { step: AgentStepView }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasDetail = !!step.summary || step.verified !== undefined;
  return (
    <li className={`hx-tool hx-tool-${step.status}${open ? ' open' : ''}`}>
      <button type="button" className="hx-tool-head" onClick={() => hasDetail && setOpen(!open)} aria-expanded={open} disabled={!hasDetail}>
        <span className="hx-dot" aria-label={STATUS_LABEL[step.status]} />
        <code className="hx-tool-name">{step.tool}</code>
        <span className="hx-tool-title">{step.title}</span>
        {!open && step.summary && step.status !== 'running' && <span className="hx-tool-sum">{step.summary}</span>}
        {hasDetail && <span className="hx-chev">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <div className="hx-tool-detail">
          <div><b>{t('状态')}</b>{t(STATUS_LABEL[step.status])}{step.verified === true ? t(' · 已验证') : step.verified === false ? t(' · 验证没通过') : ''}</div>
          {step.summary && <pre>{step.summary}</pre>}
        </div>
      )}
    </li>
  );
}

export function ToolRows({ steps }: { steps: AgentStepView[] }): JSX.Element | null {
  const t = useT();
  const shown = steps.filter((s) => s.tool !== 'update_plan');
  if (!shown.length) return null;
  return (
    <details className="hx-tool-group">
      <summary>{t('工具调用（{count}）', { count: shown.length })}</summary>
      <ul className="hx-tools">{shown.map((s) => <ToolRow key={s.stepId} step={s} />)}</ul>
    </details>
  );
}

const PLAN_MARK: Record<PlanStepView['status'], string> = { pending: '○', in_progress: '◐', done: '●', failed: '✕', skipped: '–' };

export function PlanBox({ plan }: { plan: PlanStepView[] }): JSX.Element | null {
  const t = useT();
  if (!plan.length) return null;
  const done = plan.filter((p) => p.status === 'done' || p.status === 'skipped').length;
  return (
    <div className="hx-plan">
      <div className="hx-plan-head">{t('计划')} <span>{done}/{plan.length}</span></div>
      <ol>{plan.map((p, i) => <li key={i} className={`plan-${p.status}`}><span className="hx-plan-mark">{PLAN_MARK[p.status]}</span>{p.title}</li>)}</ol>
    </div>
  );
}

const RISK = { low: '低风险', medium: '中风险', high: '高风险' } as const;

/** A permission prompt, inline in the transcript (like a harness approval). */
export function PermissionCard({ req, answer, onEdit }: { req: ConfirmRequest; answer: (id: string, d: ConfirmDecision) => void; onEdit: (prefix: string) => void }): JSX.Element {
  // Something about to be posted under the user's account: offer "改一下" next to 发 / 不发.
  const t = useT();
  const publish = req.tool === 'browser_click' && req.risk === 'high';
  return (
    <div className={`hx-perm hx-perm-${req.risk}`}>
      <div className="hx-perm-head"><span className="hx-perm-tag">{t('需要你的许可')}</span><span className={`hx-risk hx-risk-${req.risk}`}>{t(RISK[req.risk])}</span><code>{req.tool}</code></div>
      <div className="hx-perm-title">{req.title}</div>
      <p className="hx-perm-reason">{req.reason}</p>
      {req.afterExternalContent && <p className="hx-perm-warn">{t('⚠ 这一步是在读取了文件/网页等外部内容之后提出的，请确认这确实是你想要的。')}</p>}
      {req.preview.length > 0 && <pre className="hx-perm-preview">{req.preview.join('\n')}</pre>}
      <div className="hx-perm-actions">
        <button type="button" className="ok" onClick={() => answer(req.confirmId, 'allow')}>{publish ? t('发') : t('允许')}</button>
        {publish && <button type="button" onClick={() => { answer(req.confirmId, 'deny'); onEdit(t('先别发，改成：')); }}>{t('改一下')}</button>}
        {req.canAllowForTask && <button type="button" onClick={() => answer(req.confirmId, 'allow_task')}>{t('本次任务都允许')}</button>}
        <button type="button" className="no" onClick={() => answer(req.confirmId, 'deny')}>{publish ? t('不发') : t('拒绝')}</button>
      </div>
    </div>
  );
}

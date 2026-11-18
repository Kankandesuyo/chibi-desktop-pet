import { useEffect, useState, type JSX } from 'react';
import type { AgentInfo, ScheduleInfo, ScheduleTrigger } from '../../../shared/agentTypes';

type Kind = ScheduleTrigger['kind'];
const KIND_LABEL: Record<Kind, string> = { daily: '每天', interval: '每隔一段时间', once: '只一次', folder: '文件夹文件太多时' };

const when = (iso?: string): string => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/** 定时任务: what runs on its own (read-only, unattended), with a form to add one. */
export function SchedulesPage({ controls }: { controls: JSX.Element }): JSX.Element {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<Kind>('daily');
  const [time, setTime] = useState('09:00');
  const [minutes, setMinutes] = useState(60);
  const [at, setAt] = useState('');
  const [folder, setFolder] = useState('');
  const [minFiles, setMinFiles] = useState(50);

  const refresh = (): void => { void window.petAPI.agentInfo().then(setInfo); };
  useEffect(refresh, []);
  const toggle = (s: ScheduleInfo): void => { void window.petAPI.agentPlugins({ type: 'scheduleToggle', name: s.id, approve: !s.enabled }).then(setInfo); };
  const remove = (s: ScheduleInfo): void => {
    if (!window.confirm(`删除定时任务「${s.name}」？`)) return;
    void window.petAPI.agentPlugins({ type: 'scheduleDelete', name: s.id }).then(setInfo);
  };
  const create = async (): Promise<void> => {
    setError('');
    const trigger: ScheduleTrigger = kind === 'daily' ? { kind, time } : kind === 'interval' ? { kind, minutes } : kind === 'once' ? { kind, at: at ? new Date(at).toISOString() : '' } : { kind, path: folder, minFiles };
    const r = await window.petAPI.agentManage({ type: 'scheduleCreate', name, prompt, trigger });
    if (!r.ok) { setError(r.error ?? '没有创建成功'); return; }
    if (r.info) setInfo(r.info);
    setAdding(false); setName(''); setPrompt('');
  };
  const list = info?.schedules ?? [];

  return (
    <section className="page">
      <header className="page-head"><span className="page-title">定时任务</span>{controls}</header>
      <div className="page-body">
        <div className="page-narrow">
          <p className="page-lead">定时任务在没人看着的时候运行：<b>只查看和汇报，不会修改电脑</b>。需要动手的事会写在汇报里，结果出现在聊天里和系统通知中。也可以直接对她说，例如“每天早上 9 点帮我看看下载文件夹”。</p>
          <div className="page-actions top">
            <button type="button" className="btn primary" onClick={() => setAdding(!adding)}>{adding ? '取消' : '＋ 新建定时任务'}</button>
          </div>

          {adding && (
            <div className="card form-card">
              <label className="field"><span>名字</span><input type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="例如：早报" /></label>
              <label className="field"><span>要她做什么</span>
                <textarea className="field-area" rows={3} value={prompt} maxLength={1000} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：看看下载文件夹里昨天新增了哪些文件，按类型分好告诉我" />
              </label>
              <div className="field-row"><span>什么时候</span>
                <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
              </div>
              {kind === 'daily' && <label className="field-row"><span>时间</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>}
              {kind === 'interval' && <label className="field-row"><span>每隔（分钟，至少 15）</span><input type="number" min={15} max={10080} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>}
              {kind === 'once' && <label className="field-row"><span>时间</span><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>}
              {kind === 'folder' && (
                <>
                  <div className="field-row"><span>文件夹</span>
                    <span className="path-pick">
                      <input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\…\Downloads" />
                      <button type="button" className="btn ghost" onClick={() => void window.petAPI.agentPickFolder().then((f) => { if (f) setFolder(f); })}>选择…</button>
                    </span>
                  </div>
                  <label className="field-row"><span>文件数达到</span><input type="number" min={1} max={100000} value={minFiles} onChange={(e) => setMinFiles(Number(e.target.value))} /></label>
                </>
              )}
              {error && <p className="form-error">{error}</p>}
              <div className="page-actions"><button type="button" className="btn primary" onClick={() => void create()}>创建</button></div>
            </div>
          )}

          {list.length === 0 && !adding && <div className="empty">还没有定时任务</div>}
          {list.map((s) => (
            <div key={s.id} className={`card sched${s.enabled ? '' : ' off'}`}>
              <div className="sched-head">
                <b>{s.name}</b>
                <span className="chip">{s.when}</span>
                <label className="switch" title={s.enabled ? '已开启' : '已暂停'}>
                  <input type="checkbox" checked={s.enabled} onChange={() => toggle(s)} /><span />
                </label>
                <button type="button" className="link danger" onClick={() => remove(s)}>删除</button>
              </div>
              <p className="sched-prompt">{s.prompt}</p>
              <div className="sched-meta">
                <span>下次：{s.enabled ? when(s.nextRunAt) : '已暂停'}</span>
                <span>上次：{when(s.lastRunAt)}</span>
              </div>
              {s.lastResult && <pre className="sched-result">{s.lastResult}</pre>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

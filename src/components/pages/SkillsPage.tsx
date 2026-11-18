import { useEffect, useState, type JSX } from 'react';
import type { AgentInfo, SkillSummary } from '../../../shared/agentTypes';

/** 技能: what she knows how to do (SKILL.md folders). Built-in ones can be read; the user's own edited or deleted. */
export function SkillsPage({ controls }: { controls: JSX.Element }): JSX.Element {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ name: string; description: string; body: string; isNew: boolean } | null>(null);
  const [error, setError] = useState('');
  const skills = info?.skills ?? [];
  const current = skills.find((s) => s.name === selected) ?? null;

  useEffect(() => { void window.petAPI.agentInfo().then((i) => { setInfo(i); setSelected((s) => s ?? i.skills[0]?.name ?? null); }); }, []);
  useEffect(() => {
    setText('');
    if (selected) void window.petAPI.agentManage({ type: 'skillRead', name: selected }).then((r) => setText(r.ok ? r.text ?? '' : r.error ?? ''));
  }, [selected, info]);

  const body = (raw: string): string => raw.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const startEdit = (s: SkillSummary | null): void => {
    setError('');
    setEditing(s ? { name: s.name, description: s.description, body: body(text), isNew: false } : { name: '', description: '', body: '', isNew: true });
  };
  const save = async (): Promise<void> => {
    if (!editing) return;
    const r = await window.petAPI.agentManage({ type: 'skillSave', name: editing.name, description: editing.description, body: editing.body });
    if (!r.ok) { setError(r.error ?? '保存失败'); return; }
    if (r.info) setInfo(r.info);
    setSelected(editing.name.trim());
    setEditing(null);
  };
  const remove = async (s: SkillSummary): Promise<void> => {
    if (!window.confirm(`把技能「${s.name}」移到回收站？`)) return;
    const r = await window.petAPI.agentManage({ type: 'skillDelete', name: s.name });
    if (!r.ok) { setError(r.error ?? '删除失败'); return; }
    if (r.info) { setInfo(r.info); setSelected(r.info.skills[0]?.name ?? null); }
  };

  return (
    <section className="page">
      <header className="page-head"><span className="page-title">技能</span>{controls}</header>
      <div className="split">
        <div className="split-list">
          <div className="split-tools">
            <button type="button" className="btn primary small" onClick={() => startEdit(null)}>＋ 新技能</button>
            <button type="button" className="btn ghost small" onClick={() => window.petAPI.agentOpenFolder('skills')} title={info?.skillDir}>打开文件夹</button>
          </div>
          {skills.map((s) => (
            <button key={s.name} type="button" className={`split-item${s.name === selected && !editing ? ' on' : ''}`} onClick={() => { setEditing(null); setSelected(s.name); }}>
              <span className="split-item-title">{s.name}<span className={`chip ${s.source}`}>{s.source === 'builtin' ? '内置' : '我的'}</span></span>
              <small>{s.description}</small>
            </button>
          ))}
          {skills.length === 0 && <p className="hx-side-empty">还没有技能</p>}
        </div>
        <div className="split-detail">
          {editing ? (
            <div className="page-narrow">
              <h2>{editing.isNew ? '新技能' : `编辑「${editing.name}」`}</h2>
              <label className="field"><span>名字（中英文、数字、- 和 _）</span>
                <input type="text" value={editing.name} disabled={!editing.isNew} maxLength={40} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如：整理下载" />
              </label>
              <label className="field"><span>什么时候用（一句话，她靠这句话决定要不要用）</span>
                <input type="text" value={editing.description} maxLength={200} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="例如：用户要整理下载文件夹时" />
              </label>
              <label className="field"><span>具体做法（Markdown）</span>
                <textarea className="field-area mono" rows={14} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} placeholder={'1. 先列出下载文件夹里的文件\n2. 按类型分到 图片/文档/安装包 文件夹\n3. 移动前把计划告诉用户'} />
              </label>
              <small className="hint">技能只是做法说明，不是授权：她按技能做事时，每一步照常经过权限检查和确认。</small>
              {error && <p className="form-error">{error}</p>}
              <div className="page-actions">
                <button type="button" className="btn ghost" onClick={() => setEditing(null)}>取消</button>
                <button type="button" className="btn primary" onClick={() => void save()}>保存</button>
              </div>
            </div>
          ) : current ? (
            <div className="page-narrow">
              <div className="detail-head">
                <h2>{current.name}</h2>
                <span className={`chip ${current.source}`}>{current.source === 'builtin' ? '内置' : '我的'}</span>
                <span className="grow" />
                <button type="button" className="btn ghost small" onClick={() => startEdit(current)}>{current.source === 'builtin' ? '复制为我的并编辑' : '编辑'}</button>
                {current.source === 'user' && <button type="button" className="btn ghost small danger" onClick={() => void remove(current)}>删除</button>}
              </div>
              <p className="page-lead">{current.description}</p>
              <pre className="skill-text">{body(text)}</pre>
              {error && <p className="form-error">{error}</p>}
            </div>
          ) : <div className="empty">选一个技能看看</div>}
        </div>
      </div>
    </section>
  );
}

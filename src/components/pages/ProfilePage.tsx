import { useEffect, useRef, useState, type JSX } from 'react';
import type { UserProfile } from '../../../shared/profile';
import { useSettingsStore } from '../../store/settingsStore';

/** Squares and shrinks a picked picture to 160×160 so the saved avatar stays tiny. */
async function toAvatar(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('这张图片打不开')); img.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 160;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法处理图片');
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 160, 160);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

/** 我的资料: who she is talking to. Goes into her persona as background only (never a permission). */
export function ProfilePage({ controls, userAvatar, onAvatar }: { controls: JSX.Element; userAvatar: string; onAvatar(url: string): void }): JSX.Element {
  const saved = useSettingsStore((s) => s.settings.profile);
  const petName = useSettingsStore((s) => s.settings.petName) || '她';
  const [p, setP] = useState<UserProfile>(saved);
  const [flash, setFlash] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setP(saved); }, [saved]);
  const dirty = JSON.stringify({ ...p, hasAvatar: false }) !== JSON.stringify({ ...saved, hasAvatar: false });
  const set = <K extends keyof UserProfile>(k: K, v: UserProfile[K]): void => setP((x) => ({ ...x, [k]: v }));
  const show = (t: string): void => { setFlash(t); window.setTimeout(() => setFlash(''), 2000); };

  const save = async (): Promise<void> => {
    await useSettingsStore.getState().update({ profile: p });
    show('已保存 ✓');
  };
  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const r = await window.petAPI.userAvatarSet(await toAvatar(file));
      if (!r.ok) { show(r.error ?? '保存失败'); return; }
      useSettingsStore.getState().apply(r.settings);
      onAvatar(await window.petAPI.userAvatar());
    } catch (err) { show(err instanceof Error ? err.message : String(err)); }
  };
  const removeAvatar = async (): Promise<void> => {
    const r = await window.petAPI.userAvatarSet(null);
    useSettingsStore.getState().apply(r.settings);
    onAvatar('');
  };
  const letter = (p.displayName || p.callMe || '我').slice(0, 1);

  return (
    <section className="page">
      <header className="page-head"><span className="page-title">我的资料</span>{controls}</header>
      <div className="page-body">
        <div className="page-narrow">
          <p className="page-lead">让{petName}更了解你。这些资料只保存在这台电脑上，只用来调整她和你说话的方式，不会让她多出任何操作权限。</p>

          <div className="card profile-head">
            <button type="button" className="profile-avatar" onClick={() => fileRef.current?.click()} title="换头像">
              {userAvatar ? <img src={userAvatar} alt="" /> : <span>{letter}</span>}
              <em>更换</em>
            </button>
            <div className="profile-names">
              <label className="field"><span>你的名字</span>
                <input type="text" value={p.displayName} maxLength={30} onChange={(e) => set('displayName', e.target.value)} placeholder="例如：林小明" />
              </label>
              <label className="field"><span>希望{petName}怎么称呼你</span>
                <input type="text" value={p.callMe} maxLength={20} onChange={(e) => set('callMe', e.target.value)} placeholder="例如：主人、小明、老板（留空由她自己决定）" />
              </label>
              {userAvatar && <button type="button" className="link" onClick={() => void removeAvatar()}>移除头像</button>}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          </div>

          <div className="card">
            <h3>关于我</h3>
            <textarea
              className="field-area" rows={6} maxLength={2000} value={p.about} onChange={(e) => set('about', e.target.value)}
              placeholder={'随便写点你自己，例如：\n我是前端程序员，常用 VS Code 和 Chrome\n喜欢猫和独立游戏\n晚上一般 12 点睡，周末不想被提醒工作'}
            />
            <small className="hint">{p.about.length} / 2000</small>
          </div>

          <div className="card">
            <h3>偏好</h3>
            <div className="field-row"><span>回复长度</span>
              <div className="seg">
                {([['short', '简短'], ['normal', '适中'], ['detailed', '详细']] as const).map(([v, l]) => (
                  <button key={v} type="button" className={p.replyLength === v ? 'on' : ''} onClick={() => set('replyLength', v)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="field-row"><span>回复语言</span>
              <div className="seg">
                <button type="button" className={p.language === 'zh' ? 'on' : ''} onClick={() => set('language', 'zh')}>中文</button>
                <button type="button" className={p.language === 'follow' ? 'on' : ''} onClick={() => set('language', 'follow')}>跟随我说的语言</button>
              </div>
            </div>
            <label className="field-row"><span>可以用表情和颜文字</span>
              <input type="checkbox" checked={p.emoji} onChange={(e) => set('emoji', e.target.checked)} />
            </label>
            <div className="field-row"><span>勿扰时段<small>这段时间她不自言自语，定时任务的通知静音</small></span>
              <span className="time-range">
                <input type="time" value={p.quietStart} onChange={(e) => set('quietStart', e.target.value)} />
                <span>到</span>
                <input type="time" value={p.quietEnd} onChange={(e) => set('quietEnd', e.target.value)} />
                {(p.quietStart || p.quietEnd) && <button type="button" className="link" onClick={() => setP((x) => ({ ...x, quietStart: '', quietEnd: '' }))}>关闭</button>}
              </span>
            </div>
          </div>

          <div className="page-actions">
            {flash && <span className="flash-inline">{flash}</span>}
            <button type="button" className="btn ghost" disabled={!dirty} onClick={() => setP(saved)}>还原</button>
            <button type="button" className="btn primary" disabled={!dirty} onClick={() => void save()}>保存</button>
          </div>
        </div>
      </div>
    </section>
  );
}

import { useEffect, useRef, useState, type FormEvent, type JSX, type KeyboardEvent, type RefObject } from 'react';
import { SLASH_COMMANDS } from '../../../shared/harness';
import { baseName } from './format';
import { useT } from '../../i18n';

export type PermissionMode = 'readonly' | 'ask' | 'auto' | 'full';

/** In menu order. */
export const PERMISSION_LABEL: Record<PermissionMode, string> = { readonly: '只读', ask: '请求批准', auto: '替我批准', full: '完全访问' };
const PERMISSION_HINT: Record<PermissionMode, string> = {
  readonly: '只能查看，不能新建、移动、删除或运行任何东西',
  ask: '改动文件、运行命令和上网操作前都先问你',
  auto: '只在可能不安全的操作前问你',
  full: '不受限制地访问网络和电脑上的任何文件，不再询问',
};

const ModeIcon = ({ mode }: { mode: PermissionMode }): JSX.Element => {
  const common = { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (mode === 'readonly') return <svg {...common}><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></svg>;
  if (mode === 'ask') return <svg {...common}><path d="M8 11.5V5.8a1.5 1.5 0 0 1 3 0v5M11 10V4.5a1.5 1.5 0 0 1 3 0V10M14 10V5.8a1.5 1.5 0 0 1 3 0V13c0 4-2.4 7-6 7-2.6 0-4-1.3-5.4-3.4L3.8 13.8a1.4 1.4 0 0 1 2.2-1.7L8 14" /></svg>;
  if (mode === 'auto') return <svg {...common}><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="m8 10 2.5 2.5L8 15M13 15h3.5" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.5M12 16.2v.3" /></svg>;
};

interface Props {
  text: string;
  setText(t: string): void;
  onSubmit(): void;
  working: boolean;
  onStop(): void;
  placeholder: string;
  inputRef: RefObject<HTMLInputElement | null>;
  attached: string[];
  onClearAttached(): void;
  /** null = not in agent mode (no permission picker). */
  permission: PermissionMode | null;
  onPermission(m: PermissionMode): void;
}

/** The input area: attachments, slash-command completion, permission mode, send / stop. */
export function Composer(p: Props): JSX.Element {
  const t = useT();
  const [sel, setSel] = useState(0);
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modeOpen) return;
    const off = (e: MouseEvent): void => { if (!modeRef.current?.contains(e.target as Node)) setModeOpen(false); };
    const esc = (e: globalThis.KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setModeOpen(false); } };
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc, true); };
  }, [modeOpen]);
  const slash = /^\/(\S*)$/.exec(p.text);
  const matches = slash ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slash[1] as string) || c.aliases.some((a) => a.startsWith(slash[1] as string))) : [];
  const showMenu = matches.length > 0 && !(matches.length === 1 && `/${matches[0]?.name}` === p.text);

  const complete = (i: number): void => { const c = matches[i]; if (c) { p.setText(`/${c.name}`); setSel(0); } };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (!showMenu) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % matches.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + matches.length) % matches.length); }
    else if (e.key === 'Tab' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) { e.preventDefault(); complete(Math.min(sel, matches.length - 1)); }
    else if (e.key === 'Escape') { e.preventDefault(); p.setText(''); }
  };
  const submit = (e: FormEvent): void => { e.preventDefault(); p.onSubmit(); };

  return (
    <form className="hx-composer" onSubmit={submit}>
      {showMenu && (
        <ul className="hx-slash" role="listbox">
          {matches.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === sel} className={i === sel ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); complete(i); }}>
              <code>/{c.name}</code><span>{c.help}</span>
            </li>
          ))}
        </ul>
      )}
      {p.attached.length > 0 && (
        <div className="hx-attach" title={p.attached.join('\n')}>
          <span>📎 {p.attached.length === 1 ? baseName(p.attached[0] as string) : t('{first} 等 {count} 个', { first: baseName(p.attached[0] as string), count: p.attached.length })}</span>
          <button type="button" onClick={p.onClearAttached} title={t('不带这些文件')}>×</button>
        </div>
      )}
      <div className="hx-input-row">
        <input
          ref={p.inputRef} value={p.text} onChange={(e) => { p.setText(e.target.value); setSel(0); }} onKeyDown={onKey}
          placeholder={p.placeholder} maxLength={1000} autoFocus spellCheck={false}
        />
      </div>
      <div className="hx-composer-bar">
        {p.permission && (
          <div className="hx-mode-wrap" ref={modeRef}>
            {modeOpen && (
              <div className="hx-mode-menu" role="listbox">
                {(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((m) => (
                  <button
                    key={m} type="button" role="option" aria-selected={m === p.permission}
                    className={`hx-mode-${m}${m === p.permission ? ' on' : ''}`}
                    onClick={() => { p.onPermission(m); setModeOpen(false); p.inputRef.current?.focus(); }}
                  >
                    <span className="hx-mode-icon"><ModeIcon mode={m} /></span>
                    <span className="hx-mode-text"><b>{t(PERMISSION_LABEL[m])}</b><small>{t(PERMISSION_HINT[m])}</small></span>
                    {m === p.permission && <span className="hx-mode-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button" className={`hx-mode hx-mode-${p.permission}${modeOpen ? ' open' : ''}`} title={t(PERMISSION_HINT[p.permission])}
              onClick={() => setModeOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={modeOpen}
            >
              <span className="hx-mode-icon"><ModeIcon mode={p.permission} /></span>
              <span>{t(PERMISSION_LABEL[p.permission])}</span>
              <span className="hx-mode-caret">{modeOpen ? '▾' : '▴'}</span>
            </button>
          </div>
        )}
        <span className="hx-composer-tip">{t('/ 命令 · 拖文件到她身上')}</span>
        {p.working
          ? <button type="button" className="hx-send stop" onClick={p.onStop}>{t('停止')}</button>
          : <button type="submit" className="hx-send" disabled={!p.text.trim()}>{t('发送')}</button>}
      </div>
    </form>
  );
}

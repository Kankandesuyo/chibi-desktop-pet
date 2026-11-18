import { useEffect, useRef, useState, type FormEvent, type JSX, type KeyboardEvent, type RefObject } from 'react';
import { SLASH_COMMANDS } from '../../../shared/harness';
import { baseName } from './format';

export type PermissionMode = 'ask' | 'auto' | 'readonly';

export const PERMISSION_LABEL: Record<PermissionMode, string> = { ask: '询问', auto: '自动允许中风险', readonly: '只读' };
const PERMISSION_HINT: Record<PermissionMode, string> = {
  ask: '会改动电脑的步骤先问你；高风险每次都问',
  auto: '中风险直接做（读过文件/网页后仍会问）；高风险每次都问',
  readonly: '只能查看，不能新建、移动、删除或运行任何东西',
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
          <span>📎 {p.attached.length === 1 ? baseName(p.attached[0] as string) : `${baseName(p.attached[0] as string)} 等 ${p.attached.length} 个`}</span>
          <button type="button" onClick={p.onClearAttached} title="不带这些文件">×</button>
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
                    <span className="hx-mode-dot" />
                    <span className="hx-mode-text"><b>{PERMISSION_LABEL[m]}</b><small>{PERMISSION_HINT[m]}</small></span>
                    {m === p.permission && <span className="hx-mode-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button" className={`hx-mode hx-mode-${p.permission}${modeOpen ? ' open' : ''}`} title={PERMISSION_HINT[p.permission]}
              onClick={() => setModeOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={modeOpen}
            >
              <span className="hx-mode-dot" />
              <span>{PERMISSION_LABEL[p.permission]}</span>
              <span className="hx-mode-caret">{modeOpen ? '▾' : '▴'}</span>
            </button>
          </div>
        )}
        <span className="hx-composer-tip">/ 命令 · 拖文件到她身上</span>
        {p.working
          ? <button type="button" className="hx-send stop" onClick={p.onStop}>停止</button>
          : <button type="submit" className="hx-send" disabled={!p.text.trim()}>发送</button>}
      </div>
    </form>
  );
}

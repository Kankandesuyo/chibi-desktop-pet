import { useState, type FormEvent, type JSX, type KeyboardEvent, type RefObject } from 'react';
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
          <label className={`hx-mode hx-mode-${p.permission}`} title={PERMISSION_HINT[p.permission]}>
            <span className="hx-mode-dot" />
            <select value={p.permission} onChange={(e) => p.onPermission(e.target.value as PermissionMode)}>
              {(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{PERMISSION_LABEL[m]}</option>)}
            </select>
          </label>
        )}
        <span className="hx-composer-tip">/ 命令 · 拖文件到她身上</span>
        {p.working
          ? <button type="button" className="hx-send stop" onClick={p.onStop}>停止</button>
          : <button type="submit" className="hx-send" disabled={!p.text.trim()}>发送</button>}
      </div>
    </form>
  );
}

import { useRef, useState, type JSX } from 'react';
import { SettingsPanel } from '../SettingsPanel';

const SECTIONS: [string, string][] = [['set-look', '外观与动作'], ['set-her', '她自己'], ['set-ai', 'AI 聊天'], ['set-agent', '智能体']];

/** 设置, inside the main window: the settings form with a section index on top. */
export function SettingsPage({ controls }: { controls: JSX.Element }): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(SECTIONS[0]?.[0] ?? '');
  const go = (id: string): void => {
    const el = bodyRef.current?.querySelector(`#${id}`);
    if (el instanceof HTMLElement && bodyRef.current) bodyRef.current.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
    setOn(id);
  };
  const onScroll = (): void => {
    const box = bodyRef.current;
    if (!box) return;
    let current = SECTIONS[0]?.[0] ?? '';
    for (const [id] of SECTIONS) {
      const el = box.querySelector(`#${id}`);
      if (el instanceof HTMLElement && el.offsetTop - 40 <= box.scrollTop) current = id;
    }
    setOn(current);
  };
  return (
    <section className="page">
      <header className="page-head">
        <span className="page-title">设置</span>
        <nav className="hx-tabs">
          {SECTIONS.map(([id, label]) => <button key={id} type="button" className={on === id ? 'on' : ''} onClick={() => go(id)}>{label}</button>)}
        </nav>
        {controls}
      </header>
      <div className="page-body" ref={bodyRef} onScroll={onScroll}>
        <div className="page-narrow"><SettingsPanel /></div>
      </div>
    </section>
  );
}

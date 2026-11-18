import { useState, type JSX } from 'react';
import { SettingsPanel, type SettingsSection } from '../SettingsPanel';

const SECTIONS: [SettingsSection, string][] = [['set-look', '外观与动作'], ['set-her', '她自己'], ['set-ai', 'AI 聊天'], ['set-agent', '智能体']];

/** Each category opens its own settings panel. */
export function SettingsPage({ controls }: { controls: JSX.Element }): JSX.Element {
  const [on, setOn] = useState<SettingsSection>('set-look');
  return (
    <section className="page">
      <header className="page-head">
        <span className="page-title">设置</span>
        <nav className="hx-tabs">
          {SECTIONS.map(([id, label]) => <button key={id} type="button" className={on === id ? 'on' : ''} aria-pressed={on === id} aria-controls={id + '-page'} onClick={() => setOn(id)}>{label}</button>)}
        </nav>
        {controls}
      </header>
      <SettingsPanel active={on} />
    </section>
  );
}

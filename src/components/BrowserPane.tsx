import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { BrowserPaneAction, BrowserPaneState } from '../../shared/types';
import { useT } from '../i18n';

const Icon = ({ d }: { d: string }): JSX.Element => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const BACK = 'm14.5 6-6 6 6 6';
const FORWARD = 'm9.5 6 6 6-6 6';
const RELOAD = 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4';
const STOP = 'M7 7l10 10M17 7 7 17';
const EXTERNAL = 'M14 4.5h5.5V10M19.5 4.5 11 13M18 13.5v4a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4';
const CLOSE = 'M6.5 6.5l11 11M17.5 6.5l-11 11';

/**
 * The built-in browser as a pane of the main window (like Codex / Claude): a toolbar here, and the page itself
 * is a native view the main process lays exactly over `.browser-area` (we report its rectangle).
 */
export function BrowserPane({ state, width, onWidth }: { state: BrowserPaneState; width: number; onWidth(w: number): void }): JSX.Element {
  const t = useT();
  const areaRef = useRef<HTMLDivElement>(null);
  const [addr, setAddr] = useState(state.url);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { if (!editing) setAddr(state.url); }, [state.url, editing]);

  // Tell the main process where the page goes; hide it while the divider is being dragged (the native view
  // would swallow the mouse) and when this pane goes away.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return undefined;
    const send = (): void => {
      if (dragging) { window.petAPI.browserBounds(null); return; }
      const r = el.getBoundingClientRect();
      window.petAPI.browserBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener('resize', send);
    return () => { ro.disconnect(); window.removeEventListener('resize', send); };
  }, [dragging]);
  useEffect(() => () => window.petAPI.browserBounds(null), []);

  const act = (a: BrowserPaneAction): void => { void window.petAPI.browserControl(a); };
  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const start = width;
    const move = (ev: MouseEvent): void => onWidth(Math.round(start + (startX - ev.clientX)));
    const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setDragging(false); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <aside className="browser-pane" style={{ width }}>
      <div className={`browser-divider${dragging ? ' on' : ''}`} onMouseDown={startDrag} title={t('拖动调整宽度')} />
      <header className="browser-bar">
        <button type="button" onClick={() => act({ type: 'back' })} disabled={!state.canGoBack} title={t('后退')}><Icon d={BACK} /></button>
        <button type="button" onClick={() => act({ type: 'forward' })} disabled={!state.canGoForward} title={t('前进')}><Icon d={FORWARD} /></button>
        <button type="button" onClick={() => act({ type: 'reload' })} title={state.loading ? t('停止') : t('刷新')}><Icon d={state.loading ? STOP : RELOAD} /></button>
        <form className="browser-addr" onSubmit={(e) => { e.preventDefault(); if (addr.trim()) act({ type: 'navigate', url: addr }); (document.activeElement as HTMLElement | null)?.blur(); }}>
          {state.loading && <span className="browser-spin" aria-hidden="true" />}
          <input
            value={addr} spellCheck={false}
            onFocus={(e) => { setEditing(true); e.currentTarget.select(); }} onBlur={() => setEditing(false)}
            onChange={(e) => setAddr(e.target.value)} placeholder={t('输入网址或搜索')} aria-label={t('网址')}
          />
        </form>
        <button type="button" onClick={() => act({ type: 'external' })} disabled={!/^https?:/.test(state.url)} title={t('在系统浏览器中打开')}><Icon d={EXTERNAL} /></button>
        <button type="button" onClick={() => act({ type: 'close' })} title={t('关闭浏览器')}><Icon d={CLOSE} /></button>
      </header>
      <div className="browser-area" ref={areaRef}>
        {dragging && <div className="browser-drag-hint">{state.title || state.url}</div>}
      </div>
    </aside>
  );
}

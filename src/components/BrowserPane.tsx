import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { BrowserPaneAction, BrowserPaneState } from '../../shared/types';
import { useT } from '../i18n';

const Icon = ({ d, size = 16 }: { d: string; size?: number }): JSX.Element => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const BACK = 'm14.5 6-6 6 6 6';
const FORWARD = 'm9.5 6 6 6-6 6';
const RELOAD = 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4';
const STOP = 'M7 7l10 10M17 7 7 17';
const EXTERNAL = 'M14 4.5h5.5V10M19.5 4.5 11 13M18 13.5v4a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4';
const CLOSE = 'M7 7l10 10M17 7 7 17';
const GLOBE = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5Z';
const SEARCH = 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20 20';
const NEW_TAB = 'M12 6v12M6 12h12';

/** Shortcuts on the start page. */
const SITES: { label: string; url: string; letter: string }[] = [
  { label: '必应', url: 'https://www.bing.com/', letter: 'B' },
  { label: '百度', url: 'https://www.baidu.com/', letter: 'Bd' },
  { label: 'Google', url: 'https://www.google.com/', letter: 'G' },
  { label: 'GitHub', url: 'https://github.com/', letter: 'GH' },
  { label: '哔哩哔哩', url: 'https://www.bilibili.com/', letter: 'bili' },
];

interface Visit { url: string; title: string }
/** Recently visited pages: a per-viewer convenience, fine to lose. */
const loadRecent = (): Visit[] => { try { const v = JSON.parse(localStorage.getItem('browser.recent') ?? '[]') as Visit[]; return Array.isArray(v) ? v.slice(0, 8) : []; } catch { return []; } };
const saveRecent = (v: Visit[]): void => { try { localStorage.setItem('browser.recent', JSON.stringify(v.slice(0, 8))); } catch { /* private mode */ } };
const host = (u: string): string => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/**
 * The built-in browser as a pane of the main window (like Codex / Claude). The page itself is a native view the
 * main process lays exactly over `.browser-area`; with no page yet, this pane shows its own start page instead.
 */
export function BrowserPane({ state, width, onWidth }: { state: BrowserPaneState; width: number; onWidth(w: number): void }): JSX.Element {
  const t = useT();
  const areaRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const [addr, setAddr] = useState(state.url);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recent, setRecent] = useState<Visit[]>(loadRecent);
  const blank = !/^https?:/.test(state.url) && !state.error;
  const failed = !!state.error;
  useEffect(() => { if (!editing) setAddr(state.url); }, [state.url, editing]);
  // Remember where we have been (for the start page).
  useEffect(() => {
    if (blank || state.loading) return;
    setRecent((r) => { const next = [{ url: state.url, title: state.title || host(state.url) }, ...r.filter((x) => host(x.url) !== host(state.url))].slice(0, 8); saveRecent(next); return next; });
  }, [state.url, state.title, state.loading, blank]);
  useEffect(() => { if (blank) startRef.current?.focus(); }, [blank]);

  // Tell the main process where the page goes; hide it on the start page, while the divider is dragged
  // (the native view would swallow the mouse) and when this pane goes away.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return undefined;
    // Always report the size (so the right layout is picked before a page loads); show the page only when
    // it is a real page, not the start / error page, and not while the divider is dragged.
    const send = (): void => {
      const r = el.getBoundingClientRect();
      window.petAPI.browserBounds({ x: r.left, y: r.top, width: r.width, height: r.height, show: !dragging && !blank && !failed });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener('resize', send);
    return () => { ro.disconnect(); window.removeEventListener('resize', send); };
  }, [dragging, blank, failed]);
  useEffect(() => () => window.petAPI.browserBounds(null), []);

  const act = (a: BrowserPaneAction): void => { void window.petAPI.browserControl(a); };
  const go = (text: string): void => { if (text.trim()) act({ type: 'navigate', url: text }); };
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
  const tile = (key: string, label: string, sub: string, icon: JSX.Element, url: string): JSX.Element => (
    <button key={key} type="button" className="browser-tile" onClick={() => go(url)} title={url}>
      <span className="browser-tile-icon">{icon}</span>
      <span className="browser-tile-label">{label}</span>
      {sub && <span className="browser-tile-sub">{sub}</span>}
    </button>
  );

  return (
    <aside className="browser-pane" style={{ width }}>
      <div className={`browser-divider${dragging ? ' on' : ''}`} onMouseDown={startDrag} title={t('拖动调整宽度')} />
      <header className="browser-head">
        <div className="browser-tabs" role="tablist">
          {state.tabs.map((tab) => {
            const empty = !/^https?:/.test(tab.url);
            const label = empty ? t('新标签页') : tab.title || host(tab.url);
            return (
              <div
                key={tab.id} role="tab" aria-selected={tab.id === state.active} tabIndex={0}
                className={`browser-tab${tab.id === state.active ? ' on' : ''}`} title={empty ? label : `${label}
${tab.url}`}
                onClick={() => { if (tab.id !== state.active) act({ type: 'switchTab', id: tab.id }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') act({ type: 'switchTab', id: tab.id }); }}
                onAuxClick={(e) => { if (e.button === 1) act({ type: 'closeTab', id: tab.id }); }}
              >
                {tab.loading ? <span className="browser-spin" aria-hidden="true" /> : <Icon d={GLOBE} size={15} />}
                <span className="browser-tab-title">{label}</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); act({ type: 'closeTab', id: tab.id }); }} title={t('关闭标签页')}><Icon d={CLOSE} size={13} /></button>
              </div>
            );
          })}
          <button type="button" className="browser-head-btn" onClick={() => act({ type: 'newTab' })} title={t('新标签页')}><Icon d={NEW_TAB} /></button>
        </div>
        <button type="button" className="browser-head-btn" onClick={() => act({ type: 'external' })} disabled={blank} title={t('在系统浏览器中打开')}><Icon d={EXTERNAL} /></button>
      </header>
      {!blank && (
        <div className="browser-bar">
          <button type="button" onClick={() => act({ type: 'back' })} disabled={!state.canGoBack} title={t('后退')}><Icon d={BACK} /></button>
          <button type="button" onClick={() => act({ type: 'forward' })} disabled={!state.canGoForward} title={t('前进')}><Icon d={FORWARD} /></button>
          <button type="button" onClick={() => act({ type: 'reload' })} title={state.loading ? t('停止') : t('刷新')}><Icon d={state.loading ? STOP : RELOAD} /></button>
          <form className="browser-addr" onSubmit={(e) => { e.preventDefault(); go(addr); (document.activeElement as HTMLElement | null)?.blur(); }}>
            <input
              value={addr} spellCheck={false}
              onFocus={(e) => { setEditing(true); e.currentTarget.select(); }} onBlur={() => setEditing(false)}
              onChange={(e) => setAddr(e.target.value)} placeholder={t('输入网址或搜索')} aria-label={t('网址')}
            />
          </form>
        </div>
      )}
      <div className="browser-area" ref={areaRef}>
        {blank && (
          <div className="browser-start">
            <form className="browser-search" onSubmit={(e) => { e.preventDefault(); go(startRef.current?.value ?? ''); }}>
              <Icon d={SEARCH} />
              <input ref={startRef} spellCheck={false} placeholder={t('搜索或输入网址')} aria-label={t('搜索或输入网址')} />
            </form>
            <section>
              <h4>{t('常用')}</h4>
              <div className="browser-tiles">
                {SITES.map((s) => tile(s.url, t(s.label), host(s.url), <span className="browser-letter">{s.letter}</span>, s.url))}
              </div>
            </section>
            {recent.length > 0 && (
              <section>
                <h4>
                  {t('最近访问')}
                  <button type="button" className="browser-clear" onClick={() => { setRecent([]); saveRecent([]); }} title={t('清除最近访问')}>{t('清除')}</button>
                </h4>
                <div className="browser-tiles">
                  {recent.map((r) => tile(r.url, r.title, host(r.url), <Icon d={GLOBE} />, r.url))}
                </div>
              </section>
            )}
          </div>
        )}
        {failed && (
          <div className="browser-error">
            <b>{t('网页打不开')}</b>
            <p>{state.error}</p>
            <small>{t('检查网络或代理设置后再试；也可以在系统浏览器中打开。')}</small>
            <div className="browser-error-actions">
              <button type="button" className="btn primary" onClick={() => act({ type: 'reload' })}>{t('重试')}</button>
              <button type="button" className="btn ghost" onClick={() => act({ type: 'external' })}>{t('在系统浏览器中打开')}</button>
            </div>
          </div>
        )}
        {dragging && !blank && !failed && <div className="browser-drag-hint">{state.title || state.url}</div>}
      </div>
    </aside>
  );
}

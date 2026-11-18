import { useEffect, useRef, type JSX } from 'react';
import { PetEngine } from '../engine/PetEngine';
import { usePetStore } from '../store/petStore';
import { useSettingsStore } from '../store/settingsStore';
import { tNow } from '../i18n';

/** The transparent pet window: a canvas driven by PetEngine plus a small speech bubble. */
export function PetView(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bubble = usePetStore((s) => s.bubble);
  const size = useSettingsStore((s) => s.settings.size);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let engine: PetEngine | null = null;
    let cancelled = false;
    void (async () => {
      const initial = await window.petAPI.getInitialData();
      if (cancelled) return;
      useSettingsStore.getState().apply(initial.settings);
      const store = usePetStore.getState();
      store.setStats(initial.stats);
      engine = new PetEngine(window.petAPI, {
        onReady: store.setReady, onStats: store.setStats, say: (text: string, ms?: number) => store.say(tNow(text), ms),  // fixed lines are translated; her own words pass through
        // also mirrored on <body data-pet-state> so it can be inspected in DevTools and by the smoke test
        onState: (state) => { store.setState(state); document.body.dataset.petState = state; },
      }, initial);
      await engine.init(canvas);
      // Handle for DevTools and the frame-capture test (page-local; preload/IPC are unaffected).
      (window as unknown as { __petEngine?: PetEngine }).__petEngine = engine;
      if (cancelled) engine.destroy();
    })().catch((err: unknown) => console.error('[pet] failed to start', err));
    const offSettings = window.petAPI.onSettings((s) => {
      // Another character means other pictures and another manifest: start the pet view afresh.
      const changed = s.character !== useSettingsStore.getState().settings.character;
      useSettingsStore.getState().apply(s);
      if (changed && engine) window.location.reload();
    });
    return () => {
      cancelled = true;
      offSettings();
      engine?.destroy();
    };
  }, []);

  return (
    <div className="pet-root">
      <canvas ref={canvasRef} className="pet-canvas" />
      {bubble && (
        <div key={bubble.id} className="pet-bubble" style={{ fontSize: Math.max(11, Math.round(11 + 5 * size)) }}>
          {bubble.text}
        </div>
      )}
    </div>
  );
}

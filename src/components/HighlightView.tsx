import { useEffect, useState, type JSX } from 'react';
import type { HighlightRequest } from '../../shared/types';

/** How long the ring is shown (long enough for the pet to walk over and point); main hides the window a little later. */
const VISIBLE_MS = 10000;

/**
 * Full-screen, click-through overlay: a pulsing ring with a label around the spot the pet is pointing at.
 * The window never takes the mouse, so the user can click the highlighted thing straight through it.
 */
export function HighlightView(): JSX.Element {
  const [ring, setRing] = useState<HighlightRequest | null>(null);
  const [fading, setFading] = useState(false);

  useEffect(() => window.petAPI.onHighlight((h) => { setFading(false); setRing(h); }), []);
  useEffect(() => {
    if (!ring) return undefined;
    const fade = window.setTimeout(() => setFading(true), VISIBLE_MS - 600);
    const clear = window.setTimeout(() => setRing(null), VISIBLE_MS);
    return () => { window.clearTimeout(fade); window.clearTimeout(clear); };
  }, [ring]);

  if (!ring) return <div className="highlight-root" />;
  // Keep the label on screen: below the ring near the top edge, above it otherwise.
  const below = ring.y < 90;
  return (
    <div className="highlight-root">
      <div key={ring.id} className={`highlight-spot${fading ? ' fading' : ''}`} style={{ left: ring.x, top: ring.y }}>
        <div className="highlight-ring" />
        <div className="highlight-ring echo" />
        {ring.label && <div className={`highlight-label${below ? ' below' : ''}`}>{ring.label}</div>}
      </div>
    </div>
  );
}

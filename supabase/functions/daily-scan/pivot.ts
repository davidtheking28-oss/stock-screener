export interface Bar { t: number; h: number; c: number; }

// Same shape as the client's _vcp baseHigh: the highest high of the up-to-60
// completed sessions before the current bar. "Approaching" means the current
// close sits below that pivot but within minPct of it — close enough to be
// worth watching, not yet a breakout (distPct > 0 would already be one).
export function approachingPivot(bars: Bar[] | null | undefined, minPct = -8): { pivot: number; distPct: number } | null {
  if (!Array.isArray(bars) || bars.length < 21) return null;
  const cur = bars[bars.length - 1];
  const base = bars.slice(Math.max(0, bars.length - 61), bars.length - 1).filter(b => b.h != null);
  if (base.length < 20 || cur?.c == null) return null;
  const pivot = Math.max(...base.map(b => b.h));
  if (!pivot) return null;
  const distPct = (cur.c / pivot - 1) * 100;
  if (distPct > 0 || distPct < minPct) return null;
  return { pivot, distPct };
}

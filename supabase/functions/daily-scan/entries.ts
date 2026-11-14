export const REENTRY_NIGHTS = 5;

// A name hovering on a gate drops out for a night and comes back; counting that as
// a fresh entry re-sends the alert and books the same setup twice in the forward
// statistics. `prevRows` is newest-first, as the nightly scan reads it.
export function newEntries(todayTickers: string[], prevRows: { tickers?: { t: string }[] }[]): string[] {
  if (!prevRows.length) return [];
  const recent = new Set<string>();
  for (const row of prevRows.slice(0, REENTRY_NIGHTS)) for (const x of row.tickers || []) recent.add(x.t);
  return todayTickers.filter(t => !recent.has(t));
}

// The feed reports no split event, so a split shows up only as a price that fell by
// exactly 1/n. A real move landing within 3% of 1/2, 1/3 ... is rare enough to
// drop; 2/3 (a 3:2 split) is left out because genuine -33% drops are not rare.
export function isSplitLike(ratio: number): boolean {
  return [2, 3, 4, 5, 10, 20].some(n => Math.abs(ratio * n - 1) < 0.03);
}

export function forwardReturns(
  entryTickers: string[],
  priceThen: Map<string, number>,
  priceNow: Map<string, number>,
): number[] {
  const rets: number[] = [];
  for (const t of entryTickers) {
    const p0 = priceThen.get(t), p1 = priceNow.get(t);
    if (!p0 || !p1) continue;
    const ratio = p1 / p0;
    if (isSplitLike(ratio)) continue;
    rets.push((ratio - 1) * 100);
  }
  return rets;
}

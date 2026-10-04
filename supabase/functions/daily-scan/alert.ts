export interface NearPivot { pivot: number; distPct: number }
export interface AlertGroup { title: string; asOf?: string; items: { t: string; pivot: number; distPct: number; star?: boolean }[] }

export const SCREENER_TITLES: Record<string, string> = {
  sepa: 'Minervini SEPA',
  power: 'Power Play',
  vcp: 'VCP / פריצה',
  cleanbase: 'בסיס נקי',
  qulla: 'Qullamaggie',
  finviz: 'מומנטום שנתי',
  growth: 'מסנן פונדמנטלי',
};
export const SCREENER_ORDER = ['sepa', 'vcp', 'cleanbase', 'power', 'qulla', 'finviz', 'growth'];

const MAX_PER_GROUP = 12;

export function nearItems(tickers: Iterable<string>, near: Map<string, NearPivot>, star?: Set<string>) {
  return [...tickers].filter(t => near.has(t))
    .map(t => ({ t, pivot: near.get(t)!.pivot, distPct: near.get(t)!.distPct, star: star?.has(t) }))
    .sort((a, b) => b.distPct - a.distPct);
}

export function buildPivotAlert(scanDate: string, groups: AlertGroup[], wlEntries: string[], wlExits: string[], maxPct: number): string | null {
  const live = groups.filter(g => g.items.length);
  if (!live.length && !wlEntries.length && !wlExits.length) return null;
  const lines = [`SEPA ${scanDate} — קרובות לפריצת Pivot (עד ${maxPct}% מתחתיו)`];
  for (const g of live) {
    lines.push('', g.asOf ? `${g.title} (סריקה מ-${g.asOf})` : g.title);
    g.items.slice(0, MAX_PER_GROUP).forEach(i => lines.push(`${i.star ? '★' : '•'} ${i.t}  ${i.distPct.toFixed(1)}%  (Pivot ${i.pivot.toFixed(2)})`));
    if (g.items.length > MAX_PER_GROUP) lines.push(`ועוד ${g.items.length - MAX_PER_GROUP}`);
  }
  if (wlEntries.length) lines.push('', 'ברשימת המעקב נכנסו לסינון: ' + wlEntries.join(', '));
  if (wlExits.length) lines.push('', 'ברשימת המעקב יצאו מהסינון: ' + wlExits.join(', '));
  return lines.join('\n');
}

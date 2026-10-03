export interface NearPivot { pivot: number; distPct: number }

export function buildWatchlistAlert(
  scanDate: string,
  near: Map<string, NearPivot>,
  entries: string[],
  exits: string[],
  wl: Set<string>,
): string | null {
  const nearList = [...wl].filter(t => near.has(t)).sort((a, b) => near.get(b)!.distPct - near.get(a)!.distPct);
  const wlEnt = entries.filter(t => wl.has(t));
  const wlEx = exits.filter(t => wl.has(t));
  if (!nearList.length && !wlEnt.length && !wlEx.length) return null;
  const lines = [`SEPA ${scanDate} — רשימת המעקב שלך`];
  if (nearList.length) {
    lines.push('', 'מתקרבות ל-Pivot:');
    nearList.forEach(t => { const n = near.get(t)!; lines.push(`${t}  ${n.distPct.toFixed(1)}%  (Pivot ${n.pivot.toFixed(2)})`); });
  }
  if (wlEnt.length) lines.push('', 'נכנסו לסינון: ' + wlEnt.join(', '));
  if (wlEx.length) lines.push('', 'יצאו מהסינון: ' + wlEx.join(', '));
  return lines.join('\n');
}

// Pure SEPA gate/RS/score logic, split out of index.ts so it can be unit
// tested without importing a module that calls Deno.serve() at the top level
// (that would start a real listener on every test run). index.ts imports
// everything here; index_test.ts imports only from here.

export const COLUMNS = [
  "name","description","close","SMA50","SMA150","SMA200",
  "price_52_week_high","price_52_week_low","Perf.Y",
  "earnings_per_share_diluted_yoy_growth_fq",
  "total_revenue_yoy_growth_fq","return_on_equity_fq",
  "net_margin","sector","market_cap_basic",
  "average_volume_10d_calc","Perf.3M","Perf.6M",
  "earnings_per_share_diluted_qoq_growth_fq","total_revenue_qoq_growth_fq",
  "earnings_per_share_diluted_ttm","earnings_per_share_forecast_next_fy",
  "earnings_release_next_date",
];
export const C: Record<string, number> = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));

// Must mirror the client's SEPA defaults in מסנן-מניות.html. These had drifted:
// fromLow was still 0.25 (client moved to 0.30), epsMin still 25 (client's v3
// migration raised it to 50), and the EPS/revenue acceleration and forward-EPS
// gates did not exist here at all — so the nightly "נכנסו/יצאו" list and the
// app could legitimately disagree about the same day.
export const FILTERS = {
  rsMin: 70, fromHigh: 0.25, fromLow: 0.30, priceMin: 10, mcMin: 2e9, liqMin: 20e6,
  epsMin: 50, revMin: 20, roeMin: 17, epsFwdMin: 25, earnDays: 5,
};

export type Row = { s: string; d: (number | string | null)[] };

export function computeRS(universe: Row[]): Record<string, number> {
  // A missing period must not count as 0% — that punished short-history names
  // (a stock up 120% in 3M with no 6M/Y history scored below one at 40/60/80).
  // Weight only the periods that exist and renormalise. The client fixed this;
  // this copy had not, so the two ranked the same universe differently.
  const raw = (d: Row['d']) => {
    const p3 = d[C['Perf.3M']] as number | null, p6 = d[C['Perf.6M']] as number | null, py = d[C['Perf.Y']] as number | null;
    if (p3 == null && p6 == null && py == null) return null;
    let s = 0, w = 0;
    if (p3 != null) { s += 0.4 * p3; w += 0.4; }
    if (p6 != null) { s += 0.3 * p6; w += 0.3; }
    if (py != null) { s += 0.3 * py; w += 0.3; }
    return s / w;
  };
  const valid = universe.map(r => ({ s: r.s, p: raw(r.d) as number })).filter(r => r.p != null).sort((a, b) => a.p - b.p);
  const n = valid.length; const map: Record<string, number> = {};
  // n <= 1 would make i/(n-1) divide by zero and yield NaN.
  const rate = (i: number) => n <= 1 ? 50 : Math.max(1, Math.min(99, Math.round((i / (n - 1)) * 98) + 1));
  // Equal performance must get an equal rating — ranking on plain array index
  // gave tied stocks adjacent ranks, so two identical performers could
  // straddle a threshold purely on the universe's incoming sort order. The
  // client fixed this (see the same comment there); this copy had not, so a
  // tie could rank/score above rsMin in one and not the other on scan night.
  let i = 0;
  while (i < n) {
    let j = i; while (j + 1 < n && valid[j + 1].p === valid[i].p) j++;
    const r = rate((i + j) / 2);
    for (let k = i; k <= j; k++) map[valid[k].s] = r;
    i = j + 1;
  }
  return map;
}

export function applyClassicSEPA(universe: Row[], rsMap: Record<string, number>) {
  const out: { t: string; sym: string; rs: number; sc: number; c: number; sec: string }[] = [];
  for (const r of universe) {
    const d = r.d;
    const close = d[C.close] as number, s50 = d[C.SMA50] as number, s150 = d[C.SMA150] as number, s200 = d[C.SMA200] as number;
    const hi = d[C.price_52_week_high] as number, lo = d[C.price_52_week_low] as number, mc = d[C.market_cap_basic] as number;
    if ([close, s50, s150, s200, hi, lo].some(v => v == null)) continue;
    if (close < FILTERS.priceMin || mc < FILTERS.mcMin) continue;
    const avgVol = d[C.average_volume_10d_calc] as number | null;
    if (avgVol == null || close * avgVol < FILTERS.liqMin) continue;
    const rs = rsMap[r.s] ?? 0;
    // The client drops a name whose earnings land inside the next earnDays;
    // this job had no such gate, so the nightly list kept recommending stocks
    // the app itself would not show.
    const earnTs = d[C['earnings_release_next_date']] as number | null;
    if (earnTs != null && earnTs > 0) {
      const earnIn = Math.round((earnTs - Date.now() / 1000) / 86400);
      if (earnIn >= 0 && earnIn <= FILTERS.earnDays) continue;
    }
    // Criterion #3 stays on the Perf.6M proxy here on purpose: the client can
    // fall back to the real SMA200 slope (_ma200Rising) because it fetches OHLC
    // per candidate, and this bulk job has no bars to measure a slope from.
    const perf6 = d[C['Perf.6M']] as number | null;
    const eps = d[C.earnings_per_share_diluted_yoy_growth_fq] as number | null;
    const rev = d[C.total_revenue_yoy_growth_fq] as number | null;
    const roe = d[C.return_on_equity_fq] as number | null;
    const nm = d[C.net_margin] as number | null;
    const epsQoq = d[C['earnings_per_share_diluted_qoq_growth_fq']] as number | null;
    const revQoq = d[C['total_revenue_qoq_growth_fq']] as number | null;
    const epsTtm = d[C['earnings_per_share_diluted_ttm']] as number | null;
    const epsFwdFy = d[C['earnings_per_share_forecast_next_fy']] as number | null;
    // A negative or zero TTM base makes the % meaningless (-$1 -> $2 is not a
    // 300% drop), so treat it as unknown rather than passing.
    const epsFwdGrowth = (epsTtm != null && epsTtm > 0 && epsFwdFy != null) ? (epsFwdFy / epsTtm - 1) * 100 : null;
    const pass = close > s150 && close > s200 && s150 > s200 && s50 > s150 && s50 > s200
      && (perf6 != null && perf6 > 0)
      && close > s50 && close >= lo * (1 + FILTERS.fromLow) && close >= hi * (1 - FILTERS.fromHigh)
      && rs >= FILTERS.rsMin
      && eps != null && eps >= FILTERS.epsMin && rev != null && rev >= FILTERS.revMin
      && roe != null && roe >= FILTERS.roeMin && nm != null && nm > 0
      && epsQoq != null && epsQoq >= 0
      && revQoq != null && revQoq >= 0
      && epsFwdGrowth != null && epsFwdGrowth >= FILTERS.epsFwdMin;
    if (!pass) continue;
    const fromHighPct = (close / hi - 1) * 100;
    const perfY = d[C['Perf.Y']] as number | null;
    // Weights must mirror the client's calcScore('sepa'). They had drifted:
    // 40/25/20/15 here vs 35/25/15/15 + a 10-point Perf.Y term there, so the
    // nightly email ranked the same day's results differently from the app.
    const rsS = Math.min(rs, 99) / 99 * 35;
    // Same epsScore the client uses. Clamping at 0 made a wiped-out -268% YoY
    // score identically to flat 0% growth, so nothing separated a collapsing
    // company from a stagnant one.
    const epsS = Math.min(Math.max(((eps ?? -100) + 100) / 400, 0), 1) * 25;
    const revS = Math.min(Math.max(rev, 0), 200) / 200 * 15;
    // Math.abs would penalise a stock trading ABOVE its 52-week high, which the
    // client rewards — use the same one-sided distance it does.
    const hiS = Math.max(0, Math.min(1, 1 - Math.max(0, -fromHighPct) / 25)) * 15;
    const perfYS = Math.min(Math.max(perfY ?? 0, 0), 300) / 300 * 10;
    out.push({
      t: d[C.name] as string, sym: r.s, rs,
      // Mirrors the client's epsPenalty: a zero-weight EPS term stops rewarding
      // collapsing earnings but never demotes them, and the non-EPS terms alone
      // reach 75 of 100 here. null is unknown, not bad.
      // The client rounds the raw 0-100 sum to an integer BEFORE multiplying by
      // the penalty (calcScore does Math.round(_calcScoreRaw(...) * epsPenalty)
      // on an already-rounded raw); rounding only once, after multiplying the
      // unrounded terms, could land a point off on the same stock.
      sc: Math.round(Math.round(rsS + epsS + revS + hiS + perfYS)
        * (eps == null ? 1 : Math.min(Math.max(1 - 0.35 * Math.min(Math.max(-eps, 0), 100) / 100, 0.65), 1))),
      c: close, sec: (d[C.sector] as string) || '—',
    });
  }
  return out.sort((a, b) => b.sc - a.sc);
}

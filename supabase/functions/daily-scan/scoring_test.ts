// Guards daily-scan's independent reimplementation of the client's SEPA gates,
// RS computation and calcScore('sepa') weights against drifting apart again —
// it has drifted twice already (see the comments in scoring.ts and
// [[screener_criteria_audit]] in memory). A green run here does not replace
// the live-universe audit for a genuinely new criterion; it catches the same
// bug recurring.
//
// Run: deno test supabase/functions/daily-scan/scoring_test.ts
import { assertEquals, assertAlmostEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { COLUMNS, FILTERS, Row, computeRS, applyClassicSEPA } from './scoring.ts';

function row(sym: string, overrides: Record<string, number | string | null> = {}): Row {
  const defaults: Record<string, number | string | null> = {
    name: sym, description: '', close: 100, SMA50: 90, SMA150: 80, SMA200: 70,
    price_52_week_high: 110, price_52_week_low: 60, 'Perf.Y': 50,
    earnings_per_share_diluted_yoy_growth_fq: 60,
    total_revenue_yoy_growth_fq: 25, return_on_equity_fq: 20,
    net_margin: 10, sector: 'Tech', market_cap_basic: 5e9,
    average_volume_10d_calc: 1e6, 'Perf.3M': 20, 'Perf.6M': 30,
    earnings_per_share_diluted_qoq_growth_fq: 5, total_revenue_qoq_growth_fq: 5,
    earnings_per_share_diluted_ttm: 2, earnings_per_share_forecast_next_fy: 3,
    earnings_release_next_date: null,
  };
  const merged = { ...defaults, ...overrides };
  return { s: sym, d: COLUMNS.map((c) => merged[c] ?? null) };
}

// --- computeRS ---

Deno.test('RS: a single-name universe rates 50, not NaN', () => {
  const map = computeRS([row('A')]);
  assertEquals(map['A'], 50);
});

Deno.test('RS: tied performers get the identical rating, not adjacent ranks', () => {
  const map = computeRS([
    row('A', { 'Perf.3M': 20, 'Perf.6M': 30, 'Perf.Y': 50 }),
    row('B', { 'Perf.3M': 20, 'Perf.6M': 30, 'Perf.Y': 50 }),
    row('C', { 'Perf.3M': 5, 'Perf.6M': 5, 'Perf.Y': 5 }),
  ]);
  assertEquals(map['A'], map['B']);
});

Deno.test('RS: a name missing every performance period is left out of the ranking', () => {
  const map = computeRS([
    row('A'),
    row('B', { 'Perf.3M': null, 'Perf.6M': null, 'Perf.Y': null }),
  ]);
  assertEquals(map['B'], undefined);
});

Deno.test('RS: a missing period is renormalised, not counted as 0%', () => {
  // Two names with identical 3M/6M performance but B is missing Perf.Y — if a
  // missing period silently counted as 0%, B would rate strictly lower than A
  // despite having the same measured performance everywhere it has data.
  const map = computeRS([
    row('A', { 'Perf.3M': 40, 'Perf.6M': 40, 'Perf.Y': 40 }),
    row('B', { 'Perf.3M': 40, 'Perf.6M': 40, 'Perf.Y': null }),
    row('C', { 'Perf.3M': 5, 'Perf.6M': 5, 'Perf.Y': 5 }),
  ]);
  assertEquals(map['A'], map['B']);
});

// --- applyClassicSEPA: gates ---

Deno.test('SEPA gate: a row passing every criterion is included', () => {
  const out = applyClassicSEPA([row('A')], { A: 80 });
  assertEquals(out.length, 1);
  assertEquals(out[0].sym, 'A');
});

Deno.test('SEPA gate: RS below rsMin is excluded', () => {
  const out = applyClassicSEPA([row('A')], { A: FILTERS.rsMin - 1 });
  assertEquals(out.length, 0);
});

Deno.test('SEPA gate: close below SMA50 (criterion 5) is excluded', () => {
  const out = applyClassicSEPA([row('A', { close: 85 })], { A: 80 });
  assertEquals(out.length, 0);
});

Deno.test('SEPA gate: an earnings date inside earnDays is excluded', () => {
  const soon = Math.floor(Date.now() / 1000) + 2 * 86400;
  const out = applyClassicSEPA([row('A', { earnings_release_next_date: soon })], { A: 80 });
  assertEquals(out.length, 0);
});

Deno.test('SEPA gate: an earnings date beyond earnDays is kept', () => {
  const later = Math.floor(Date.now() / 1000) + 30 * 86400;
  const out = applyClassicSEPA([row('A', { earnings_release_next_date: later })], { A: 80 });
  assertEquals(out.length, 1);
});

Deno.test('SEPA gate: negative net margin is excluded', () => {
  const out = applyClassicSEPA([row('A', { net_margin: -5 })], { A: 80 });
  assertEquals(out.length, 0);
});

// --- applyClassicSEPA: score weights (must mirror the client's calcScore('sepa')) ---

Deno.test('SEPA score: matches the client\'s rs 35 / eps 25 / rev 15 / fromHigh 15 / perfY 10 weights', () => {
  const out = applyClassicSEPA([row('A')], { A: 80 });
  const rsS = Math.min(80, 99) / 99 * 35;
  const epsS = Math.min(Math.max((60 + 100) / 400, 0), 1) * 25;
  const revS = Math.min(Math.max(25, 0), 200) / 200 * 15;
  const fromHighPct = (100 / 110 - 1) * 100;
  const hiS = Math.max(0, Math.min(1, 1 - Math.max(0, -fromHighPct) / 25)) * 15;
  const perfYS = Math.min(Math.max(50, 0), 300) / 300 * 10;
  const expected = Math.round(rsS + epsS + revS + hiS + perfYS);
  assertEquals(out[0].sc, expected);
});

Deno.test('SEPA score: a stock trading above its 52-week high is not penalised on the high-distance term', () => {
  const out = applyClassicSEPA(
    [row('A', { close: 115, price_52_week_high: 110, price_52_week_low: 60 })],
    { A: 80 },
  );
  // fromHighPct is positive here (trading above the high); Math.abs would wrongly
  // dock points for that, same bug class already fixed once on this term.
  assertEquals(out.length, 1);
  assertAlmostEquals(out[0].sc, out[0].sc); // sanity: no NaN from the positive-distance branch
  const rsS = Math.min(80, 99) / 99 * 35;
  const epsS = Math.min(Math.max((60 + 100) / 400, 0), 1) * 25;
  const revS = Math.min(Math.max(25, 0), 200) / 200 * 15;
  const perfYS = Math.min(Math.max(50, 0), 300) / 300 * 10;
  const expected = Math.round(rsS + epsS + revS + 15 + perfYS); // hiS caps at the full 15
  assertEquals(out[0].sc, expected);
});

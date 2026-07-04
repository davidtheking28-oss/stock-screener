/* Regression assertions for the screener's pure logic.
   Runs inside the loaded app page (via tests/run-tests.py) against the REAL
   in-page functions — no copies. Returns [{name, pass, detail}]. */
(() => {
  const R = [];
  const check = (name, cond, detail) => R.push({ name, pass: !!cond, detail: cond ? '' : (detail || '') });

  // build a universe row from a {columnName: value} map, keyed into C
  const mkStock = (s, f) => {
    const d = [];
    for (const k in f) { if (C[k] == null) throw 'unknown column: ' + k; d[C[k]] = f[k]; }
    return { s, d };
  };
  const tickers = rows => rows.map(r => r.ticker).sort();
  const eqSet = (a, b) => a.length === b.length && a.slice().sort().every((x, i) => x === b.slice().sort()[i]);

  // ── _ma200Rising ──
  const mk = closes => closes.map((c, i) => ({ t: i * 86400, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }));
  check('_ma200Rising: steady uptrend → true',
    _ma200Rising(mk(Array.from({ length: 252 }, (_, i) => 100 + i * 0.4))) === true);
  check('_ma200Rising: recent breakdown → false',
    _ma200Rising(mk(Array.from({ length: 252 }, (_, i) => i < 212 ? 100 + i * 0.4 : 100 + 212 * 0.4 - (i - 212) * 3))) === false);
  check('_ma200Rising: <222 bars → null (unknown, kept)',
    _ma200Rising(mk(Array.from({ length: 100 }, (_, i) => 100 + i))) === null);

  // ── _powerPlayOK ──
  const good = [].concat(Array(20).fill(50), Array.from({ length: 30 }, (_, i) => 50 + 60 * (i / 29)), Array.from({ length: 10 }, (_, i) => 110 - 8 * (i / 9)));
  const slowBase = [].concat(Array.from({ length: 30 }, (_, i) => 48 + i * 0.05), Array.from({ length: 20 }, (_, i) => 50 + 60 * (i / 19)), Array.from({ length: 8 }, (_, i) => 110 - 6 * (i / 7)));
  const deep = [].concat(Array(10).fill(50), Array.from({ length: 25 }, (_, i) => 50 + 60 * (i / 24)), Array.from({ length: 15 }, (_, i) => 110 - 44 * (i / 14)));
  const weak = [].concat(Array(20).fill(50), Array.from({ length: 30 }, (_, i) => 50 + 30 * (i / 29)), Array.from({ length: 8 }, (_, i) => 80 - 2 * (i / 7)));
  check('_powerPlayOK: 100%+ run + tight consolidation → true', _powerPlayOK(mk(good), 100) === true);
  check('_powerPlayOK: explosive move off a long base → true', _powerPlayOK(mk(slowBase), 100) === true);
  check('_powerPlayOK: deep (>25%) correction → false', _powerPlayOK(mk(deep), 100) === false);
  check('_powerPlayOK: only +60% (no doubling) → false', _powerPlayOK(mk(weak), 100) === false);

  // ── computeRS: monotonic in composite performance ──
  {
    const uni = [
      mkStock('r:A', { 'Perf.3M': 0, 'Perf.6M': 0, 'Perf.Y': 0 }),
      mkStock('r:B', { 'Perf.3M': 10, 'Perf.6M': 10, 'Perf.Y': 10 }),
      mkStock('r:C', { 'Perf.3M': 20, 'Perf.6M': 20, 'Perf.Y': 20 }),
    ];
    const m = computeRS(uni);
    check('computeRS: stronger perf → higher rank', m['r:C'] > m['r:B'] && m['r:B'] > m['r:A'], JSON.stringify(m));
  }

  // ── applyFilters: SEPA trend template isolates each criterion ──
  {
    setScreener('sepa', true);
    if ($('useFund')) $('useFund').checked = false;
    if ($('requireProfit')) $('requireProfit').checked = false;
    if ($('requireEpsAccel')) $('requireEpsAccel').checked = false;
    const base = { close: 100, SMA50: 95, SMA150: 90, SMA200: 85, price_52_week_high: 115, price_52_week_low: 60,
      market_cap_basic: 5e9, average_volume_10d_calc: 1e6, volume: 1e6, 'Perf.Y': 50, 'Perf.3M': 20, 'Perf.6M': 30,
      earnings_release_next_date: 0, sector: 'Technology Services', description: 'x', exchange: 'NASDAQ', 'Volatility.D': 2, 'Volatility.M': 5 };
    const uni = [
      mkStock('T:STRONGA', { ...base, name: 'STRONGA' }),
      mkStock('T:WEAKRS', { ...base, name: 'WEAKRS' }),
      mkStock('T:BELOWMA', { ...base, name: 'BELOWMA', close: 80 }),            // close < SMA50 → fails t5/t1
      mkStock('T:FARHIGH', { ...base, name: 'FARHIGH', price_52_week_high: 200 }), // >25% below high → fails t7
    ];
    const rsMap = { 'T:STRONGA': 85, 'T:WEAKRS': 50, 'T:BELOWMA': 85, 'T:FARHIGH': 85 };
    const out = tickers(applyFilters(uni, rsMap));
    check('applyFilters SEPA: keeps only the fully-compliant stock', eqSet(out, ['STRONGA']), 'got ' + JSON.stringify(out));
  }

  // ── applyFilters: Fundamental (growth) sector allow-list + QoQ thresholds ──
  {
    setScreener('growth', true);
    const base = { close: 50, SMA50: 40, SMA150: 40, SMA200: 40, price_52_week_high: 60, price_52_week_low: 30,
      market_cap_basic: 5e9, average_volume_10d_calc: 1e6, volume: 1e6, description: 'x', exchange: 'NASDAQ',
      earnings_per_share_diluted_qoq_growth_fq: 20, total_revenue_qoq_growth_fq: 30 };
    const uni = [
      mkStock('G:GROWA', { ...base, name: 'GROWA', sector: 'Technology Services' }),
      mkStock('G:BADSEC', { ...base, name: 'BADSEC', sector: 'Utilities' }),
      mkStock('G:LOWEPS', { ...base, name: 'LOWEPS', sector: 'Technology Services', earnings_per_share_diluted_qoq_growth_fq: 10 }),
      mkStock('G:LOWMC', { ...base, name: 'LOWMC', sector: 'Technology Services', market_cap_basic: 1e9 }),
    ];
    const out = tickers(applyFilters(uni, {}));
    check('applyFilters growth: sector + EPS/Sales QoQ + cap gate', eqSet(out, ['GROWA']), 'got ' + JSON.stringify(out));
  }

  // ── applyFilters: Commodities fixed-ticker membership ──
  {
    setScreener('commodities', true);
    const base = { close: 200, SMA50: 190, SMA150: 180, SMA200: 170, price_52_week_high: 210, price_52_week_low: 150,
      average_volume_10d_calc: 1e6, volume: 1e6, description: 'x', exchange: 'ARCA' };
    const uni = [
      mkStock('C:GLD', { ...base, name: 'GLD' }),
      mkStock('C:AAPL', { ...base, name: 'AAPL' }),
    ];
    const out = tickers(applyFilters(uni, {}));
    check('applyFilters commodities: only listed tickers', eqSet(out, ['GLD']), 'got ' + JSON.stringify(out));
  }

  setScreener('sepa', true); // restore
  return R;
})()

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

  // ── _vcp ──
  {
    // helper: build bars with an explicit volume series
    const mkv = (closes, vols) => closes.map((c, i) => ({
      t: i * 86400, o: c, h: c * 1.005, l: c * 0.995, c,
      v: vols ? vols[i] : 1000
    }));
    // Three contractions, each shallower: -20%, -12%, -6%, volume drying up.
    const leg = (from, to, len) => Array.from({ length: len }, (_, i) => from + (to - from) * (i / (len - 1)));
    const vcpCloses = [].concat(
      leg(100, 140, 30),  // advance
      leg(140, 112, 12),  // -20%
      leg(112, 138, 12),
      leg(138, 121, 10),  // -12%
      leg(121, 139, 10),
      leg(139, 131, 8)    // -6%
    );
    const vcpVols = [].concat(
      Array(30).fill(2000), Array(12).fill(1800), Array(12).fill(1400),
      Array(10).fill(1100), Array(10).fill(900), Array(8).fill(500)
    );
    const v = _vcp(mkv(vcpCloses, vcpVols));
    check('_vcp: successive shallower pullbacks → >=2 contractions', v && v.contractions >= 2,
      'got ' + JSON.stringify(v));
    check('_vcp: last contraction tighter than the previous → tighteningOK', v && v.tighteningOK === true,
      'got ' + JSON.stringify(v));
    check('_vcp: volume drying into the pivot → volDryUp', v && v.volDryUp === true,
      'got ' + JSON.stringify(v));
    check('_vcp: pivot is the base high, price below it → negative distToPivot',
      v && v.distToPivot < 0, 'got ' + JSON.stringify(v));

    // Widening pullbacks (-6% then -20%) must NOT read as tightening.
    const wide = [].concat(leg(100, 140, 30), leg(140, 132, 10), leg(132, 141, 10), leg(141, 113, 12));
    const wv = _vcp(mkv(wide));
    check('_vcp: widening pullbacks → tighteningOK false', wv && wv.tighteningOK === false,
      'got ' + JSON.stringify(wv));

    check('_vcp: too few bars → null', _vcp(mkv(leg(100, 110, 20))) === null);

    // A straight run-up with no pullback has nothing to contract.
    const straight = _vcp(mkv(leg(100, 180, 80)));
    check('_vcp: uninterrupted advance → no real contractions',
      straight && straight.contractions === 0, 'got ' + JSON.stringify(straight));
  }

  // ── _rsLine ──
  {
    const bar = (t, c) => ({ t, o: c, h: c, l: c, c, v: 1000 });
    const flatBench = Array.from({ length: 80 }, (_, i) => bar(i * 86400, 100));
    // Stock outperforming a flat benchmark → RS line at its high.
    const strong = Array.from({ length: 80 }, (_, i) => bar(i * 86400, 100 + i));
    const s = _rsLine(strong, flatBench);
    check('_rsLine: outperformer → RS line at new high', s && s.atHigh === true, 'got ' + JSON.stringify(s));
    check('_rsLine: at high → pctFromHigh ~0', s && Math.abs(s.pctFromHigh) < 0.2, 'got ' + JSON.stringify(s));

    // Rolled over near the end → RS line off its high.
    const fading = Array.from({ length: 80 }, (_, i) => bar(i * 86400, i < 60 ? 100 + i : 160 - (i - 60) * 2));
    const f = _rsLine(fading, flatBench);
    check('_rsLine: faded vs benchmark → not at high', f && f.atHigh === false, 'got ' + JSON.stringify(f));
    check('_rsLine: faded → negative pctFromHigh', f && f.pctFromHigh < -5, 'got ' + JSON.stringify(f));

    // Benchmark rising faster than the stock → underperformance.
    const benchFast = Array.from({ length: 80 }, (_, i) => bar(i * 86400, 100 + i * 3));
    const u = _rsLine(strong, benchFast);
    check('_rsLine: benchmark outruns stock → not at high', u && u.atHigh === false, 'got ' + JSON.stringify(u));

    check('_rsLine: too little overlap → null', _rsLine(strong.slice(0, 10), flatBench) === null);
    check('_rsLine: no benchmark → null', _rsLine(strong, null) === null);
    // Misaligned timestamps must drop points, not silently shift the series.
    const shifted = Array.from({ length: 80 }, (_, i) => bar(i * 86400 + 1, 100));
    check('_rsLine: non-overlapping timestamps → null', _rsLine(strong, shifted) === null);
  }

  setScreener('sepa', true); // restore
  return R;
})()

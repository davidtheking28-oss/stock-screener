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
  // The consolidation legs are >=15 bars: a Power Play is the run PLUS a 3-6
  // week base, and a shorter tail now fails on duration rather than depth.
  const good = [].concat(Array(10).fill(50), Array.from({ length: 25 }, (_, i) => 50 + 60 * (i / 24)), Array.from({ length: 18 }, (_, i) => 110 - 14 * (i / 17)));
  const slowBase = [].concat(Array.from({ length: 25 }, (_, i) => 48 + i * 0.05), Array.from({ length: 20 }, (_, i) => 50 + 60 * (i / 19)), Array.from({ length: 16 }, (_, i) => 110 - 12 * (i / 15)));
  const deep = [].concat(Array(10).fill(50), Array.from({ length: 25 }, (_, i) => 50 + 60 * (i / 24)), Array.from({ length: 15 }, (_, i) => 110 - 44 * (i / 14)));
  const weak = [].concat(Array(20).fill(50), Array.from({ length: 30 }, (_, i) => 50 + 30 * (i / 29)), Array.from({ length: 8 }, (_, i) => 80 - 2 * (i / 7)));
  // Doubled and still going — nothing has consolidated yet. Depth alone reads
  // this as maximally tight (~0% off the high), which is exactly the hole the
  // duration guard closes.
  const fresh = [].concat(Array(15).fill(50), Array.from({ length: 30 }, (_, i) => 50 + 60 * (i / 29)), Array(3).fill(109));
  check('_powerPlayOK: 100%+ run + tight consolidation → true', _powerPlayOK(mk(good), 100) === true);
  check('_powerPlayOK: explosive move off a long base → true', _powerPlayOK(mk(slowBase), 100) === true);
  check('_powerPlayOK: deep (>25%) correction → false', _powerPlayOK(mk(deep), 100) === false);
  check('_powerPlayOK: only +60% (no doubling) → false', _powerPlayOK(mk(weak), 100) === false);
  check('_powerPlayOK: peaked days ago, no base yet → false', _powerPlayOK(mk(fresh), 100) === false);

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
    // Isolate the eight Trend Template criteria — every fundamental gate off.
    // Keep this list in sync when a toggle is added: requireRevAccel defaults
    // ON, and leaving it on made this fixture (which carries no revenue data)
    // fail with an empty result set.
    ['useFund', 'requireProfit', 'requireEpsAccel', 'requireRevAccel', 'requireMarginTrend', 'requireVCP']
      .forEach(id => { if ($(id)) $(id).checked = false; });
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

  // ── Regressions fixed 2026-08-15. Each of these reached production. ──

  // skipFund builds the watchlist's "passes the Trend Template" reference set.
  // A price floor is not a Trend Template criterion, but priceMin stayed live
  // under skipFund, so the verdict changed with whichever screener was last
  // scanned (priceMin is 10 on sepa, 5 on qulla, 3 on finviz, 0 on growth).
  {
    setScreener('sepa', true);
    const base = { close: 6, SMA50: 5.5, SMA150: 5, SMA200: 4.5, price_52_week_high: 7, price_52_week_low: 3,
      market_cap_basic: 5e9, average_volume_10d_calc: 1e7, volume: 1e7, 'Perf.Y': 50, 'Perf.3M': 20, 'Perf.6M': 30,
      earnings_release_next_date: 0, sector: 'Technology Services', description: 'x', exchange: 'NASDAQ' };
    const uni = [mkStock('T:CHEAP', { ...base, name: 'CHEAP' })];
    const rsMap = { 'T:CHEAP': 85 };
    setFieldValue($('priceMin'), 10);           // a $6 stock is below the floor
    const out = tickers(applyFilters(uni, rsMap, { skipFund: true }));
    check('skipFund: priceMin must not gate the Trend Template set', eqSet(out, ['CHEAP']),
      'a $6 stock passing all 8 criteria was dropped by a $10 price floor; got ' + JSON.stringify(out));
    setScreener('sepa', true); // restore priceMin
  }

  // SORTS.mc returned undefined for rows with no market cap (they survive the
  // filter whenever mcMin is 0). undefined compares 0 against everything, which
  // makes the comparator non-transitive and jumbles the WHOLE list.
  {
    const f = SORTS.mc;
    check('SORTS.mc: missing market cap sorts last, not everywhere',
      typeof f({}) === 'number' && f({}) < f({ mc: 1 }),
      'got ' + JSON.stringify(f({})));
  }

  // Volatility.D is one session's high/low range and runs about half the true
  // ADR; it also sits near zero for the whole universe early in a session. The
  // ADR column, the sort, the score and the journal stop-loss all read it.
  {
    const r = { close: 100, ADR: 4 };
    const row = mkStock('T:ADR', { close: 100, ADR: 4, SMA50: 90, SMA150: 85, SMA200: 80,
      price_52_week_high: 105, price_52_week_low: 50, market_cap_basic: 5e9,
      average_volume_10d_calc: 1e7, volume: 1e7, 'Perf.Y': 50, 'Perf.3M': 20, 'Perf.6M': 30,
      'Volatility.D': 2, earnings_release_next_date: 0, sector: 'Technology Services',
      description: 'x', exchange: 'NASDAQ', name: 'ADRT' });
    setScreener('sepa', true);
    ['useFund', 'requireProfit', 'requireEpsAccel', 'requireRevAccel', 'requireMarginTrend']
      .forEach(id => { if ($(id)) $(id).checked = false; });
    const out = applyFilters([row], { 'T:ADR': 85 });
    check('adrPct: derived from the real ADR column, not Volatility.D',
      out.length === 1 && Math.abs(out[0].adrPct - 4) < 1e-9,
      'ADR $4 on a $100 stock is 4%, Volatility.D would say 2%; got ' + JSON.stringify(out[0] && out[0].adrPct));
  }

  // Ranking on the raw array index gave tied stocks adjacent ratings, so two
  // identical performers could straddle a threshold (69 vs 70) purely on the
  // universe's incoming market-cap sort order.
  {
    const uni = [
      mkStock('t:LOW',  { 'Perf.3M': 0,  'Perf.6M': 0,  'Perf.Y': 0 }),
      mkStock('t:TIE1', { 'Perf.3M': 10, 'Perf.6M': 10, 'Perf.Y': 10 }),
      mkStock('t:TIE2', { 'Perf.3M': 10, 'Perf.6M': 10, 'Perf.Y': 10 }),
      mkStock('t:TIE3', { 'Perf.3M': 10, 'Perf.6M': 10, 'Perf.Y': 10 }),
      mkStock('t:HIGH', { 'Perf.3M': 20, 'Perf.6M': 20, 'Perf.Y': 20 }),
    ];
    const m = computeRS(uni);
    check('computeRS: equal performance → equal RS rating',
      m['t:TIE1'] === m['t:TIE2'] && m['t:TIE2'] === m['t:TIE3'], JSON.stringify(m));
    check('computeRS: ties still rank between the weaker and stronger names',
      m['t:LOW'] < m['t:TIE1'] && m['t:TIE1'] < m['t:HIGH'], JSON.stringify(m));
  }

  // The saved-prefs version was hardcoded to 2 on every write, so each load
  // re-ran every migration's "only touch the old default" guard forever.
  check('FILTERS_VERSION matches the highest migration', typeof FILTERS_VERSION === 'number' && FILTERS_VERSION >= 5,
    'got ' + (typeof FILTERS_VERSION === 'undefined' ? 'undefined' : FILTERS_VERSION));

  // The nightly Edge Function (supabase/functions/daily-scan) reimplements the
  // SEPA gates and had silently drifted from these. Pin the client side so a
  // change here is visible when diffing the two.
  {
    setScreener('sepa', true);
    const vals = { epsMin: num('epsMin'), revMin: num('revMin'), roeMin: num('roeMin'),
                   epsFwdMin: num('epsFwdMin'), fromLow: num('fromLow'), fromHigh: num('fromHigh'), rsMin: num('rsMin') };
    check('SEPA defaults match the nightly job (update daily-scan together)',
      vals.epsMin === 50 && vals.revMin === 20 && vals.roeMin === 17 && vals.epsFwdMin === 25
        && vals.fromLow === 30 && vals.fromHigh === 25 && vals.rsMin === 70,
      'got ' + JSON.stringify(vals));
  }

  // The nightly job also reimplements calcScore, and *that* half was never
  // pinned — it stayed on 40/25/20/15 with a clamp(eps,0,300) floor long after
  // the client moved to 35/25/15/15 + Perf.Y and to epsScore. Isolating each
  // term makes any weight change here fail until daily-scan is changed too.
  {
    setScreener('sepa', true);
    const z = { rs: 0, eps: -100, rev: 0, fromHighPct: -25, perfY: 0 };
    check('SEPA score: nothing scores 0', calcScore(z) === 0, 'got ' + calcScore(z));
    check('SEPA score: RS is worth 35', calcScore({ ...z, rs: 99 }) === 35, 'got ' + calcScore({ ...z, rs: 99 }));
    check('SEPA score: EPS YoY is worth 25', calcScore({ ...z, eps: 300 }) === 25, 'got ' + calcScore({ ...z, eps: 300 }));
    check('SEPA score: revenue YoY is worth 15', calcScore({ ...z, rev: 200 }) === 15, 'got ' + calcScore({ ...z, rev: 200 }));
    check('SEPA score: distance from high is worth 15', calcScore({ ...z, fromHighPct: 0 }) === 15, 'got ' + calcScore({ ...z, fromHighPct: 0 }));
    check('SEPA score: yearly performance is worth 10', calcScore({ ...z, perfY: 300 }) === 10, 'got ' + calcScore({ ...z, perfY: 300 }));
    // Flat 0% growth and wiped-out earnings used to score identically; epsScore
    // floors true zero at -100%, so a collapsing company must score strictly
    // lower than a stagnant one.
    check('SEPA score: collapsing EPS scores below flat EPS',
      calcScore({ ...z, eps: -80 }) < calcScore({ ...z, eps: 0 }),
      calcScore({ ...z, eps: -80 }) + ' vs ' + calcScore({ ...z, eps: 0 }));
  }

  // The fundamental screener was the one calcScore branch the ranking fix never
  // reached: it scored on epsQoq/revQoq alone, so a single good sequential
  // quarter outranked everything. Live proof was BATRA (RS 62, year +23%, EPS
  // YoY -140%) placing first and MU (RS 98, +726%, +1372%) third.
  {
    const q = { epsQoq: 20, revQoq: 30 };
    const junk = { ...q, rs: 62, perfY: 23, eps: -140 };
    const real = { ...q, rs: 98, perfY: 726, eps: 1372 };
    check('growth score: same QoQ, stronger stock and YoY wins',
      calcScore(real, 'growth') > calcScore(junk, 'growth'),
      calcScore(real, 'growth') + ' vs ' + calcScore(junk, 'growth'));
    // Each term pinned on its own, so dropping any one of them is visible.
    const gz = { epsQoq: 0, revQoq: 0, rs: 0, perfY: 0, eps: -100 };
    const g = o => calcScore({ ...gz, ...o }, 'growth');
    check('growth score: QoQ still carries the most weight', g({ epsQoq: 100, revQoq: 150 }) === 55, 'got ' + g({ epsQoq: 100, revQoq: 150 }));
    check('growth score: EPS QoQ is worth 30', g({ epsQoq: 100 }) === 30, 'got ' + g({ epsQoq: 100 }));
    check('growth score: revenue QoQ is worth 25', g({ revQoq: 150 }) === 25, 'got ' + g({ revQoq: 150 }));
    check('growth score: RS is worth 15', g({ rs: 99 }) === 15, 'got ' + g({ rs: 99 }));
    check('growth score: yearly performance is worth 15', g({ perfY: 300 }) === 15, 'got ' + g({ perfY: 300 }));
    check('growth score: EPS YoY is worth 15', g({ eps: 300 }) === 15, 'got ' + g({ eps: 300 }));
  }

  // Qullamaggie screens the market's biggest gainers, not any stock that moved.
  {
    setScreener('qulla', true);
    const m = { move3Min: num('move3Min'), move6Min: num('move6Min'), adrMin: num('adrMin') };
    check('Qullamaggie defaults require a real prior move',
      m.move3Min === 20 && m.move6Min === 30 && m.adrMin === 3, 'got ' + JSON.stringify(m));
  }

  // Criterion #3 (SMA200 rising). validateExact runs the real slope check via
  // _ma200Rising when bars are reachable; applyFilters keeps the Perf.6M proxy
  // only for the no-Supabase / skipFund paths. The test page has no anon key,
  // so HAS_SUPABASE is false here and this exercises exactly that fallback —
  // the branch that must not silently drop the criterion.
  {
    setScreener('sepa', true);
    ['useFund', 'requireProfit', 'requireEpsAccel', 'requireRevAccel', 'requireMarginTrend', 'requireVCP']
      .forEach(id => { if ($(id)) $(id).checked = false; });
    const base = { close: 100, SMA50: 95, SMA150: 90, SMA200: 85, price_52_week_high: 115, price_52_week_low: 60,
      market_cap_basic: 5e9, average_volume_10d_calc: 1e6, volume: 1e6, 'Perf.Y': 50, 'Perf.3M': 20,
      earnings_release_next_date: 0, sector: 'Technology Services', description: 'x', exchange: 'NASDAQ' };
    const uni = [
      mkStock('m:RISING', { ...base, name: 'RISING', 'Perf.6M': 30 }),
      mkStock('m:FALLING', { ...base, name: 'FALLING', 'Perf.6M': -6 }),
    ];
    const out = tickers(applyFilters(uni, { 'm:RISING': 85, 'm:FALLING': 85 }));
    check('criterion #3 falls back to Perf.6M when no bars are reachable',
      eqSet(out, ['RISING']), 'got ' + JSON.stringify(out));
  }

  setScreener('sepa', true); // restore
  return R;
})()

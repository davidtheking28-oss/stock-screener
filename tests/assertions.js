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
  // The consolidation legs are >=10 bars: a Power Play is the run PLUS a base,
  // and a shorter tail now fails on duration rather than depth.
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
  // Minervini's own 3-week reading leaves ~1 name on a live universe, so the
  // duration is a filter field. Both ends of it have to keep working.
  check('_powerPlayOK: duration threshold is configurable', _powerPlayOK(mk(good), 100, 25) === false && _powerPlayOK(mk(fresh), 100, 0) === true);
  {
    setScreener('power', true);
    check('Power Play default consolidation is 2 weeks', num('consolWeeks') === 2, 'got ' + num('consolWeeks'));
    setScreener('sepa', true);
  }

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
    // eps:null, not -100: null is "nothing reported", which scores zero points
    // AND takes no epsPenalty, so each term below is isolated cleanly.
    const z = { rs: 0, eps: null, rev: 0, fromHighPct: -25, perfY: 0 };
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
    const gz = { epsQoq: 0, revQoq: 0, rs: 0, perfY: 0, eps: null };
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

  // A zero-weight EPS term does not punish collapsing earnings, it only stops
  // rewarding them — TWST held 5th place on the breakout screener with EPS YoY
  // -268% because the non-EPS terms alone reach 80 of 100 there.
  {
    check('epsPenalty: healthy growth is untouched', epsPenalty(300) === 1 && epsPenalty(0) === 1);
    check('epsPenalty: no reported EPS is unknown, not bad', epsPenalty(null) === 1 && epsPenalty(undefined) === 1);
    check('epsPenalty: wiped-out earnings scale the score down', epsPenalty(-100) === 0.65, 'got ' + epsPenalty(-100));
    check('epsPenalty: floors, so -268% is not worse than -100%', epsPenalty(-268) === 0.65, 'got ' + epsPenalty(-268));
    check('epsPenalty: monotonic between', epsPenalty(-10) > epsPenalty(-50) && epsPenalty(-50) > epsPenalty(-90));
    // The whole point: the penalty must outrank a strong technical profile.
    const strongTech = { rs: 99, fromHighPct: 0, perf3: 150, perf6: 150, perfY: 300, rev: 0 };
    // Was pinned on the breakout screener until it was removed; 'power' is the
    // same score branch, so the coverage moves rather than disappearing.
    check('power: collapsing EPS demotes a technically perfect name',
      calcScore({ ...strongTech, eps: -268 }, 'power') < calcScore({ ...strongTech, eps: null }, 'power'),
      calcScore({ ...strongTech, eps: -268 }, 'power') + ' vs ' + calcScore({ ...strongTech, eps: null }, 'power'));
    check('the removed breakout screener is gone from the registry',
      SCREENERS.momentum === undefined && SCREENER_DEFAULTS.momentum === undefined
      && !document.querySelector('[data-screener="momentum"]'));
    // Anyone whose last session ended on the removed screener has that key in
    // localStorage. Without the fallback setScreener early-returns and the
    // panel boots with no panel-* class at all — every screener's fields
    // visible at once.
    check('a stored screener key that no longer exists falls back to sepa',
      _validScreener('momentum') === 'sepa' && _validScreener('') === 'sepa'
      && _validScreener('qulla') === 'qulla' && _validScreener('vcp') === 'vcp');
    // Commodities have no issuer, so scaling them all by one factor would just
    // relabel a constant as a signal.
    check('commodities are exempt from the EPS penalty',
      calcScore({ rs: 99, fromHighPct: 0, perf3: 150, perf6: 0, perfY: 300, eps: -268 }, 'commodities')
        === calcScore({ rs: 99, fromHighPct: 0, perf3: 150, perf6: 0, perfY: 300, eps: null }, 'commodities'));
  }

  // validateExact needs Supabase and a fetch per candidate, so its gates had no
  // coverage at all. _sepaExactFail is the same decision as a pure function.
  {
    const rising = mk(Array.from({ length: 252 }, (_, i) => 100 + i * 0.4));
    const falling = mk(Array.from({ length: 252 }, (_, i) => i < 212 ? 100 + i * 0.4 : 100 + 212 * 0.4 - (i - 212) * 3));
    const short = mk(Array.from({ length: 100 }, (_, i) => 100 + i));
    const okVcp = { contractions: 3, tighteningOK: true };
    check('exact: rising SMA200 passes', _sepaExactFail({ perf6: 30 }, rising) === false);
    check('exact: falling SMA200 fails', _sepaExactFail({ perf6: 30 }, falling) === true);
    check('exact: too little history falls back to Perf.6M',
      _sepaExactFail({ perf6: 30 }, short) === false && _sepaExactFail({ perf6: -6 }, short) === true);
    check('exact: no bars at all still falls back to Perf.6M',
      _sepaExactFail({ perf6: 30 }, null) === false && _sepaExactFail({ perf6: -6 }, null) === true);
    check('exact: VCP gate is off unless asked for',
      _sepaExactFail({ perf6: 30 }, rising) === false
      && _sepaExactFail({ perf6: 30 }, rising, { reqVcp: true }) === true
      && _sepaExactFail({ perf6: 30, vcp: okVcp }, rising, { reqVcp: true }) === false);
    check('exact: VCP gate needs 2+ contractions AND tightening',
      _sepaExactFail({ perf6: 30, vcp: { contractions: 1, tighteningOK: true } }, rising, { reqVcp: true }) === true
      && _sepaExactFail({ perf6: 30, vcp: { contractions: 3, tighteningOK: false } }, rising, { reqVcp: true }) === true);
    check('exact: RS-line gate is off unless asked for',
      _sepaExactFail({ perf6: 30 }, rising, { reqRsLine: true }) === true
      && _sepaExactFail({ perf6: 30, rsLine: { atHigh: true } }, rising, { reqRsLine: true }) === false
      && _sepaExactFail({ perf6: 30, rsLine: { atHigh: false } }, rising, { reqRsLine: true }) === true);
  }

  // ── VCP screener ──
  // _vcp is the shared base detector (it also feeds the SEPA toggle and the VCP
  // column); _vcpExactFail is the screener's own gate on top of it, and unlike
  // the toggle it is mandatory — every assertion here is about a row being
  // DROPPED, which is the direction a regression would silently reverse.
  {
    // Three pullbacks, each shallower than the last, on falling volume, ending
    // just under the pivot: the textbook pattern.
    const base = (depths, tail) => {
      const b = [];
      let px = 60;
      for (let i = 0; i < 200; i++) b.push({ t: i * 86400, o: px, h: px * 1.005, l: px * 0.995, c: px, v: 3000, _px: px = px + 0.2 });
      // px is now ~100 and the SMA200 is rising. Lay the base on top of it.
      let hi = px;
      depths.forEach((d, k) => {
        const lo = hi * (1 - d / 100);
        for (let i = 0; i < 6; i++) b.push({ t: (200 + k * 12 + i) * 86400, o: hi, h: hi, l: hi - (hi - lo) * (i / 5), c: hi - (hi - lo) * (i / 5), v: 3000 - k * 700 });
        for (let i = 0; i < 6; i++) b.push({ t: (200 + k * 12 + 6 + i) * 86400, o: lo, h: lo + (hi - lo) * (i / 5), l: lo, c: lo + (hi - lo) * (i / 5), v: 3000 - k * 700 });
      });
      const last = b[b.length - 1];
      b.push({ t: last.t + 86400, o: last.c, h: hi * tail, l: hi * tail * 0.99, c: hi * tail, v: 900 });
      return b;
    };
    const rising = base([12, 8, 4], 0.985);
    const vGood = _vcp(rising);
    check('_vcp: tightening base is detected', vGood && vGood.contractions >= 2 && vGood.tighteningOK === true,
      JSON.stringify(vGood));
    // The VCP screener's tightening rule reads the whole sequence, so _vcp has
    // to keep handing it out — tighteningOK alone is only the last two legs.
    check('_vcp: exposes every leg depth, not just the last two',
      Array.isArray(vGood.depths) && vGood.depths.length === vGood.contractions
      && Math.abs(vGood.depths[vGood.depths.length - 1] - vGood.lastDepth) < 0.01,
      JSON.stringify(vGood.depths));

    const row = b => ({ perf6: 30, vcp: _vcp(b) });
    check('vcp: a tightening base just under the pivot passes',
      _vcpExactFail(row(rising), rising, { minC: 2, maxDepth: 12, maxBelow: 10, reqDryUp: false }) === false,
      JSON.stringify(_vcp(rising)));
    // Widening instead of contracting — the single thing the pattern is named for.
    const widening = base([4, 8, 12], 0.985);
    check('vcp: a WIDENING base is dropped',
      _vcpExactFail(row(widening), widening, { minC: 2, maxDepth: 20, maxBelow: 10, reqDryUp: false }) === true);
    // Already broken out and extended — Minervini enters AT the pivot.
    const extended = base([12, 8, 4], 1.08);
    check('vcp: price already extended above the pivot is dropped',
      _vcpExactFail(row(extended), extended, { minC: 2, maxDepth: 12, maxBelow: 10, reqDryUp: false }) === true,
      JSON.stringify(_vcp(extended).distToPivot));
    // Sitting at the low of the last contraction rather than at its top — a
    // valid, still-tightening base that is simply not actionable yet. Driven
    // off a synthetic _vcp result on purpose: a fixture deep enough to move
    // distToPivot also makes the last leg the DEEPEST one, which trips
    // tighteningOK first and would leave the pivot gate never exercised.
    const deepInBase = { contractions: 3, lastDepth: 12, tighteningOK: true, volDryUp: true, pivot: 100, distToPivot: -12 };
    check('vcp: still far below the pivot is dropped',
      _vcpExactFail({ perf6: 30, vcp: deepInBase }, rising, { minC: 2, maxDepth: 12, maxBelow: 10, reqDryUp: false }) === true);
    check('vcp: the pivot distance is a configurable field, not a constant',
      _vcpExactFail({ perf6: 30, vcp: deepInBase }, rising, { minC: 2, maxDepth: 12, maxBelow: 25, reqDryUp: false }) === false);
    // Last contraction still 12% deep — a base, but not a tight one.
    const loose = base([25, 18, 12], 0.985);
    check('vcp: last contraction deeper than the max is dropped',
      _vcpExactFail(row(loose), loose, { minC: 2, maxDepth: 8, maxBelow: 10, reqDryUp: false }) === true);
    // Synthetic depths so the count and the sequence can be varied one at a
    // time — the OHLC fixture's own leg count includes noise legs that are not
    // monotonic, which is exactly the case the sequence rule below exists for.
    const withDepths = ds => ({ perf6: 30, vcp: { contractions: ds.length, depths: ds, lastDepth: ds[ds.length - 1], tighteningOK: ds[ds.length - 1] < ds[ds.length - 2], volDryUp: true, pivot: 100, distToPivot: -2 } });
    const g = { maxDepth: 12, maxBelow: 10, reqDryUp: false };
    check('vcp: the minimum contraction count is honoured at the boundary',
      _vcpExactFail(withDepths([12, 8, 4]), rising, { ...g, minC: 3 }) === false
      && _vcpExactFail(withDepths([12, 8, 4]), rising, { ...g, minC: 4 }) === true);
    // The whole point of the pattern: EVERY leg in the required window has to
    // be shallower than the one before it. tighteningOK alone compares only the
    // last two, so ten noisy legs pass it whenever the final pair happens to
    // shrink — measured live, that is how GOOG/XOM/WELL reached the top of this
    // screener before the sequence rule replaced it.
    check('vcp: tightening is measured across the whole required window',
      _vcpExactFail(withDepths([4, 12, 9, 6]), rising, { ...g, minC: 3 }) === false
      && _vcpExactFail(withDepths([4, 12, 9, 6]), rising, { ...g, minC: 4 }) === true);
    check('vcp: a flat (non-shrinking) leg is not a contraction',
      _vcpExactFail(withDepths([10, 6, 6]), rising, { ...g, minC: 3 }) === true);
    // Rows restored from an older results cache predate the depths array.
    check('vcp: falls back to tighteningOK when depths are absent',
      _vcpExactFail({ perf6: 30, vcp: { contractions: 3, lastDepth: 4, tighteningOK: true, volDryUp: true, pivot: 100, distToPivot: -2 } }, rising, { ...g, minC: 3 }) === false
      && _vcpExactFail({ perf6: 30, vcp: { contractions: 3, lastDepth: 4, tighteningOK: false, volDryUp: true, pivot: 100, distToPivot: -2 } }, rising, { ...g, minC: 3 }) === true);
    // No bars = the base was never measured. This screener has nothing to fall
    // back on, so it must drop the row rather than pass it through unchecked.
    check('vcp: no OHLC bars drops the row (no Perf.6M fallback)',
      _vcpExactFail({ perf6: 300 }, null) === true);
    const falling = mk(Array.from({ length: 252 }, (_, i) => i < 212 ? 100 + i * 0.4 : 100 + 212 * 0.4 - (i - 212) * 3));
    check('vcp: a falling SMA200 drops the row',
      _vcpExactFail({ perf6: 30, vcp: _vcp(rising) }, falling) === true);
    // volDryUp is null when volume is unknown; the toggle must not pass that off
    // as a confirmed dry-up.
    // Clean synthetic legs on purpose: the OHLC fixture's own tail is not
    // monotonic under the default 3-leg window, so reusing it here would fail
    // on the sequence rule and never reach the dry-up branch at all.
    const dryBase = { contractions: 3, depths: [12, 8, 4], lastDepth: 4, tighteningOK: true, pivot: 100, distToPivot: -2 };
    check('vcp: the dry-up toggle requires a definite yes',
      _vcpExactFail({ perf6: 30, vcp: { ...dryBase, volDryUp: null } }, rising, { reqDryUp: true }) === true
      && _vcpExactFail({ perf6: 30, vcp: { ...dryBase, volDryUp: false } }, rising, { reqDryUp: true }) === true
      && _vcpExactFail({ perf6: 30, vcp: { ...dryBase, volDryUp: true } }, rising, { reqDryUp: true }) === false);
    // The shipped default is 3 legs, not 2 — measured live, 2 returns 129 names
    // whose sequences are mostly noise (NTRA: 9.17, 9.34, 9.15, 6.45) against
    // 45 clean ones at 3.
    check('vcp: the default contraction window is 3 legs',
      _vcpExactFail({ perf6: 30, vcp: { ...dryBase, depths: [4, 8, 9, 4], contractions: 4, volDryUp: true } }, rising) === true
      && _vcpExactFail({ perf6: 30, vcp: { ...dryBase, depths: [4, 8, 9, 4], contractions: 4, volDryUp: true } }, rising, { minC: 2 }) === false
      && _vcpExactFail({ perf6: 30, vcp: { ...dryBase, volDryUp: true } }, rising) === false);

    setScreener('vcp', true);
    check('vcp screener is registered with its own defaults',
      activeScreener === 'vcp' && num('vcpContractions') === 3 && num('vcpDepthMax') === 12 && num('pivotBelow') === 10,
      activeScreener + '/' + num('vcpContractions') + '/' + num('vcpDepthMax') + '/' + num('pivotBelow'));
    // The score is what orders the results, and every term of it reads r.vcp.
    // Scoring before validateExact annotates the row is the bug this pins.
    const mkRow = v => ({ rs: 80, eps: 20, vcp: v });
    // Pinned one term at a time, across its full range. A combined
    // "tighter AND nearer ranks higher" comparison passes with either term
    // zeroed out — verified by mutation, it survived both.
    const vAt = (d, p) => mkRow({ contractions: 3, lastDepth: d, distToPivot: p, volDryUp: true });
    check('vcp score: base tightness is worth 25',
      calcScore(vAt(0, -1), 'vcp') - calcScore(vAt(15, -1), 'vcp') === 25,
      calcScore(vAt(0, -1), 'vcp') + ' vs ' + calcScore(vAt(15, -1), 'vcp'));
    check('vcp score: proximity to the pivot is worth 25',
      calcScore(vAt(4, 0), 'vcp') - calcScore(vAt(4, -10), 'vcp') === 25,
      calcScore(vAt(4, 0), 'vcp') + ' vs ' + calcScore(vAt(4, -10), 'vcp'));
    check('vcp score: a confirmed volume dry-up is worth points',
      calcScore(mkRow({ contractions: 3, lastDepth: 4, distToPivot: -1, volDryUp: true }), 'vcp')
        > calcScore(mkRow({ contractions: 3, lastDepth: 4, distToPivot: -1, volDryUp: false }), 'vcp'));
    check('vcp score: an unannotated row does not outrank a real base',
      calcScore(mkRow(null), 'vcp')
        < calcScore(mkRow({ contractions: 3, lastDepth: 4, distToPivot: -1, volDryUp: true }), 'vcp'));
  }

  // ── data-integrity gates (audited against Nasdaq's official history) ──
  {
    const steady = mk(Array.from({ length: 200 }, (_, i) => 50 + i * 0.2));
    check('_barsSane: a normal series passes', _barsSane(steady) === true);
    // A real split in an unadjusted feed, or a 40% news gap: ONE jump, never
    // reverting. Must be kept — AMD gapped 23.7% in this universe legitimately.
    const oneJump = mk([...Array.from({ length: 100 }, (_, i) => 100 + i * 0.1),
                        ...Array.from({ length: 100 }, (_, i) => 55 + i * 0.05)]);
    check('_barsSane: a single one-way jump is kept (real split / news gap)',
      _barsSane(oneJump) === true);
    // The real MNST shape: Yahoo returned these exact closes while Nasdaq's
    // official history showed 46.78 / 48.87 / 46.775 on the doubled days.
    const mnst = mk([97.50, 47.72, 47.23, 47.83, 93.56, 93.49, 95.33, 97.74, 97.23, 97.65, 48.19, 93.55, 94.18]);
    check('_barsSane: a series that flips price scale is rejected',
      _barsSane(mnst) === false);
    check('_barsSane: too little history is not judged', _barsSane([{ c: 1 }]) === true);

    // Qullamaggie's prior-move gates, the ones the coarse pass gets wrong.
    // 130 bars so the 6M window (127) is measurable, 3M (64) too.
    // n=130, so the 6M lookback lands on index 3 (n-127) and the 3M one on
    // index 66 (n-64). Those two indices carry the anchor prices; getting the
    // boundaries off by one silently tests nothing.
    const move = (pct6, pct3) => {
      const n6 = 130, final = 100 * (1 + pct6 / 100), mid = final / (1 + pct3 / 100);
      const out = [];
      for (let i = 0; i < n6; i++) {
        const px = i <= 3 ? 100 : i <= 66 ? mid : final;
        out.push({ t: i * 86400, o: px, h: px * 1.02, l: px * 0.98, c: px, v: 1000 });
      }
      return out;
    };
    // ADR ~4%, sitting on its EMAs, flat week — so only the move gates decide.
    const g = (b, m3, m6) => _qullaExactOK(b, 0, 100, 100, m3, m6);
    // Each case clears the gate it is not testing, so a failure names the one
    // criterion that actually broke.
    check('qulla: a 6-month move below the threshold now fails',
      g(move(20, 25), 20, 30) === false, 'CRCT-shaped: real +20.5% against a 30% gate');
    check('qulla: a 6-month move above the threshold passes',
      g(move(45, 25), 20, 30) === true);
    check('qulla: the 3-month move is checked too',
      g(move(60, 5), 20, 30) === false && g(move(60, 25), 20, 30) === true);
    check('qulla: the move gates are skipped when they are switched off',
      g(move(2, 1), 0, 0) === true);
    // Same rule the rest of _qullaExactOK follows: not enough history is
    // unknown, not failing.
    const shortHist = move(2, 1).slice(-40);
    check('qulla: too little history does not fail the 6M gate',
      _qullaExactOK(shortHist, 0, 100, 100, 0, 30) === true);

    // The coarse ADR slack. TradingView's column runs as low as 0.751x the
    // true 20-bar ADR, so a 0.9 gate rejects names that do qualify.
    setScreener('qulla', true);
    const src = applyFilters.toString();
    check('qulla: the coarse ADR gate allows for the column understating by 25%',
      src.includes("num('adrMin')*0.75"), 'slack must be 0.75, not 0.9');
    setScreener('sepa', true);

    // validateExact needs Supabase and a fetch per candidate, so the suite
    // cannot run it. Both gates below were verified by mutation to be
    // otherwise uncovered: deleting either left every test green. Shape
    // assertions are the weakest kind, so they are deliberately narrow —
    // each names the one expression that must survive a refactor.
    const vsrc = validateExact.toString();
    check('validateExact drops a row whose bar series flips price scale',
      /if\(\s*raw\s*&&\s*!bars\s*\)\s*r\._exactFail\s*=\s*true/.test(vsrc),
      'computing _barsSane is not enough — the row must actually be dropped');
    check('validateExact passes the move thresholds into _qullaExactOK',
      /_qullaExactOK\([^)]*move3Min[^)]*move6Min[^)]*\)/.test(vsrc),
      'without these the 3M/6M gates silently never run');
  }

  setScreener('sepa', true); // restore
  return R;
})()

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const mem = new Map<string, { bars: unknown; time: number }>();
const MEM_TTL = 15 * 60 * 1000;      // 15min in-instance
const DB_TTL = 45 * 60 * 1000;       // 45min persistent freshness (3mo bars)
const DB_TTL_1Y = 6 * 60 * 60 * 1000; // 6h persistent freshness (1y bars — daily, finalize once/day)

const _rate = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 400;   // one screener scan validates ~150 survivors from a single IP

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

function mapSymbol(raw: string): string {
  const s = raw.includes(':') ? raw.split(':')[1] : raw;
  // TradingView writes class/preferred shares as BRK.B and USB/PP; Yahoo wants
  // BRK-B and USB-PP. Only the dot was translated, so every preferred share 404'd
  // and its chart fell back to whatever stale bars were already cached.
  return s.replace(/[./]/g, '-').toUpperCase().slice(0, 12);
}

async function dbGet(ckey: string): Promise<{ bars: unknown; age: number } | null> {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/market_cache?cache_key=eq.${encodeURIComponent('ohlc:' + ckey)}&select=payload,refreshed_at`,
      { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return { bars: rows[0].payload, age: Date.now() - new Date(rows[0].refreshed_at).getTime() };
  } catch { return null; }
}

async function dbPut(ckey: string, bars: unknown): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/market_cache`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ cache_key: 'ohlc:' + ckey, payload: bars, refreshed_at: new Date().toISOString() }),
    });
  } catch { /* cache write is best-effort */ }
}

async function fetchYahoo(sym: string, range: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!r.ok) throw new Error('Yahoo ' + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no data');
  const ts: number[] = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const bars = ts.map((t, i) => ({
    t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
  }));
  // Yahoo intermittently ships the most recent trading day with open/high/low/volume
  // populated but close:null (the close hasn't "finalized" in their chart payload yet,
  // even well after market close) — our filter below would drop the whole day,
  // making every chart look one full trading day stale. meta.regularMarketPrice is
  // the last traded price, so patch it in when it falls within that bar's own
  // high/low range (sanity check against using a stale/mismatched meta value).
  const last = bars[bars.length - 1];
  const rmp = res.meta?.regularMarketPrice;
  const rmt = res.meta?.regularMarketTime;
  // Only trust rmp for this bar if it belongs to the same session — otherwise a
  // symbol that stopped trading days ago would get its last price stamped onto a
  // day it never traded.
  const sameDay = last != null && rmt != null &&
    new Date(rmt * 1000).toISOString().slice(0, 10) === new Date(last.t * 1000).toISOString().slice(0, 10);
  if (last && last.c == null && rmp != null && sameDay && last.l != null && last.h != null) {
    // Clamp: after-hours prints legitimately fall outside the regular-session range.
    last.c = Math.min(last.h, Math.max(last.l, rmp));
  }
  await fillGaps(sym, bars);
  return bars.filter((b) => b.o != null && b.c != null).map((b) => ({
    ...b,
    // Yahoo ships the occasional thin-name bar with high < open (an opening
    // auction print their high/low never absorbed). A candle whose body escapes
    // its own wick can't be drawn, so widen the range to contain open and close.
    h: Math.max(b.h ?? b.o, b.o, b.c),
    l: Math.min(b.l ?? b.o, b.o, b.c),
  }));
}

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

// Yahoo's daily series sporadically loses whole sessions — on 2026-07-24 roughly
// 80% of US tickers came back as an all-null row, leaving a visible hole in the
// middle of every chart. Their intraday series still has those sessions, so
// rebuild the missing daily bar by aggregating the hourly one. Never touches the
// newest bar (the meta patch above owns that) and never invents a session that
// has no intraday prints, so a genuinely untraded day stays absent.
async function fillGaps(sym: string, bars: { t: number; o?: number; h?: number; l?: number; c?: number; v?: number }[]) {
  const holes = bars.slice(0, -1).filter((b) => b.o == null || b.c == null);
  if (!holes.length) return;
  const from = Math.min(...holes.map((b) => b.t)) - 86400;
  const to = Math.max(...holes.map((b) => b.t)) + 2 * 86400;
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1h&period1=${from}&period2=${to}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },
    );
    if (!r.ok) return;
    const res = (await r.json())?.chart?.result?.[0];
    const ts: number[] = res?.timestamp || [];
    const q = res?.indicators?.quote?.[0] || {};
    const want = new Set(holes.map((b) => dayOf(b.t)));
    const agg = new Map<string, { o: number; h: number; l: number; c: number; v: number; n: number }>();
    ts.forEach((t, i) => {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      const d = dayOf(t);
      if (o == null || c == null || h == null || l == null || !want.has(d)) return;
      const a = agg.get(d);
      if (!a) agg.set(d, { o, h, l, c, v: q.volume?.[i] || 0, n: 1 });
      else { a.h = Math.max(a.h, h); a.l = Math.min(a.l, l); a.c = c; a.v += q.volume?.[i] || 0; a.n++; }
    });
    for (const b of holes) {
      const a = agg.get(dayOf(b.t));
      // A real session spans several hourly bars; a single one is Yahoo's
      // live-price stub, not a day's trading.
      if (!a || a.n < 2) continue;
      b.o = a.o; b.c = a.c; b.v = a.v;
      // The opening auction print lands in the first hourly bar's open but not
      // always in its high/low, which can leave high < open on thin names.
      b.h = Math.max(a.h, a.o, a.c);
      b.l = Math.min(a.l, a.o, a.c);
    }
  } catch { /* gap filling is best-effort — a hole beats a wrong bar */ }
}

function ok(sym: string, bars: unknown, src: string) {
  return new Response(JSON.stringify({ symbol: sym, bars }), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': src },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const rl = _rate.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (rl.resetAt < now) { rl.count = 0; rl.resetAt = now + 60_000; }
  rl.count++;
  _rate.set(ip, rl);
  if (rl.count > RATE_LIMIT) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429, headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get('symbol') || '';
  if (!raw) return new Response(JSON.stringify({ error: 'missing symbol' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  const sym = mapSymbol(raw);
  const range = url.searchParams.get('range') === '1y' ? '1y' : '3mo';
  const ckey = range === '1y' ? '1y:' + sym : sym;

  // 1. warm in-instance cache
  const m = mem.get(ckey);
  if (m && Date.now() - m.time < MEM_TTL) return ok(sym, m.bars, 'MEM');

  // 2. persistent DB cache (fresh)
  const cached = await dbGet(ckey);
  if (cached && cached.age < (range === '1y' ? DB_TTL_1Y : DB_TTL)) {
    mem.set(ckey, { bars: cached.bars, time: Date.now() });
    return ok(sym, cached.bars, 'DB');
  }

  // 3. fetch fresh; on failure serve stale DB data if available
  try {
    const bars = await fetchYahoo(sym, range);
    mem.set(ckey, { bars, time: Date.now() });
    dbPut(ckey, bars);
    return ok(sym, bars, 'LIVE');
  } catch (e) {
    if (cached) return ok(sym, cached.bars, 'STALE');
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});

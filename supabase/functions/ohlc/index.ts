import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const mem = new Map<string, { bars: unknown; time: number }>();
const MEM_TTL = 60 * 60 * 1000;      // 1h in-instance
const DB_TTL = 6 * 60 * 60 * 1000;   // 6h persistent freshness

const _rate = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 120;

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

function mapSymbol(raw: string): string {
  const s = raw.includes(':') ? raw.split(':')[1] : raw;
  return s.replace('.', '-').toUpperCase().slice(0, 12);
}

async function dbGet(sym: string): Promise<{ bars: unknown; age: number } | null> {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/market_cache?cache_key=eq.${encodeURIComponent('ohlc:' + sym)}&select=payload,refreshed_at`,
      { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return { bars: rows[0].payload, age: Date.now() - new Date(rows[0].refreshed_at).getTime() };
  } catch { return null; }
}

async function dbPut(sym: string, bars: unknown): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/market_cache`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ cache_key: 'ohlc:' + sym, payload: bars, refreshed_at: new Date().toISOString() }),
    });
  } catch { /* cache write is best-effort */ }
}

async function fetchYahoo(sym: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=3mo`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!r.ok) throw new Error('Yahoo ' + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no data');
  const ts: number[] = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
  })).filter((b) => b.o != null && b.c != null);
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

  const raw = new URL(req.url).searchParams.get('symbol') || '';
  if (!raw) return new Response(JSON.stringify({ error: 'missing symbol' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  const sym = mapSymbol(raw);

  // 1. warm in-instance cache
  const m = mem.get(sym);
  if (m && Date.now() - m.time < MEM_TTL) return ok(sym, m.bars, 'MEM');

  // 2. persistent DB cache (fresh)
  const cached = await dbGet(sym);
  if (cached && cached.age < DB_TTL) {
    mem.set(sym, { bars: cached.bars, time: Date.now() });
    return ok(sym, cached.bars, 'DB');
  }

  // 3. fetch fresh; on failure serve stale DB data if available
  try {
    const bars = await fetchYahoo(sym);
    mem.set(sym, { bars, time: Date.now() });
    dbPut(sym, bars);
    return ok(sym, bars, 'LIVE');
  } catch (e) {
    if (cached) return ok(sym, cached.bars, 'STALE');
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CACHE_KEY = 'scan:america';
let mem: { data: unknown; time: number } | null = null;
const MEM_TTL = 5 * 60 * 1000;   // 5 min in-instance
const DB_TTL = 5 * 60 * 1000;    // 5 min persistent freshness

const _rate = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 12;

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

async function dbGet(): Promise<{ data: unknown; age: number } | null> {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/market_cache?cache_key=eq.${encodeURIComponent(CACHE_KEY)}&select=payload,refreshed_at`,
      { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return { data: rows[0].payload, age: Date.now() - new Date(rows[0].refreshed_at).getTime() };
  } catch { return null; }
}

async function dbPut(data: unknown): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/market_cache`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ cache_key: CACHE_KEY, payload: data, refreshed_at: new Date().toISOString() }),
    });
  } catch { /* best-effort */ }
}

function ok(data: unknown, src: string) {
  return new Response(JSON.stringify(data), {
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
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again in a minute.' }), {
      status: 429, headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }

  // 1. warm in-instance cache
  if (mem && Date.now() - mem.time < MEM_TTL) return ok(mem.data, 'MEM');

  // 2. persistent DB cache (fresh)
  const cached = await dbGet();
  if (cached && cached.age < DB_TTL) {
    mem = { data: cached.data, time: Date.now() };
    return ok(cached.data, 'DB');
  }

  // 3. fetch fresh; on failure serve stale cached data if available
  try {
    const body = await req.json();
    const res = await fetch(
      'https://scanner.tradingview.com/america/scan?label-product=screener-stock',
      { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error('TradingView ' + res.status);
    const data = await res.json();
    mem = { data, time: Date.now() };
    dbPut(data);
    return ok(data, 'LIVE');
  } catch (e) {
    if (cached) return ok(cached.data, 'STALE');
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serveCached } from "../_shared/market_cache.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function cacheKey(body: unknown): string {
  const s = JSON.stringify(body);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'scan:america:' + (h >>> 0).toString(36);
}
const mem = new Map<string, { data: unknown; time: number }>();
const MEM_TTL = 5 * 60 * 1000;   // 5 min in-instance
const DB_TTL = 5 * 60 * 1000;    // 5 min persistent freshness
// A full-market scan is the heaviest fetch in this project, so this is also
// where a TTL-only cache hurt most — see _shared/market_cache.ts. Past the TTL
// but under this bound, the last scan is served immediately and refreshed
// behind the response instead of blocking the caller on TradingView.
const MAX_STALE = 20 * 60 * 1000; // 20 min

const _rate = new Map<string, { count: number; resetAt: number }>();
// A scan now issues TWO queries (stocks, then ADRs — see fetchUniverse in the
// client), so the old ceiling of 12 allowed only 6 scans/minute.
const RATE_LIMIT = 24;

async function fetchLive(body: unknown): Promise<unknown> {
  const res = await fetch(
    'https://scanner.tradingview.com/america/scan?label-product=screener-stock',
    { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error('TradingView ' + res.status);
  return res.json();
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

  let body: unknown = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const key = cacheKey(body);

  // 1. warm in-instance cache
  const m = mem.get(key);
  if (m && Date.now() - m.time < MEM_TTL) return ok(m.data, 'MEM');

  // 2. persistent DB cache — fresh, stale-but-usable (background refresh), or
  // a blocking live fetch past MAX_STALE
  try {
    const { data, src } = await serveCached(key, DB_TTL, MAX_STALE, () => fetchLive(body));
    mem.set(key, { data, time: Date.now() });
    return ok(data, src);
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

let _cache: { data: unknown; time: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

const _rate = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 12;

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

  try {
    if (_cache && Date.now() - _cache.time < CACHE_TTL) {
      return new Response(JSON.stringify(_cache.data), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }

    const body = await req.json();
    const res = await fetch(
      'https://scanner.tradingview.com/america/scan?label-product=screener-stock',
      { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) }
    );

    if (!res.ok) throw new Error('TradingView ' + res.status);
    const data = await res.json();
    _cache = { data, time: Date.now() };

    return new Response(JSON.stringify(data), {
      headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});

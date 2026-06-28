import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const cache = new Map<string, { data: unknown; time: number }>();
const TTL = 60 * 60 * 1000; // 1h

const _rate = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 120;

function mapSymbol(raw: string): string {
  const s = raw.includes(':') ? raw.split(':')[1] : raw;
  return s.replace('.', '-').toUpperCase().slice(0, 12);
}

async function fetchBars(sym: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=3mo`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!r.ok) throw new Error('Yahoo ' + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no data');
  const ts: number[] = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const bars = ts.map((t, i) => ({
    t,
    o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
  })).filter((b) => b.o != null && b.c != null);
  return bars;
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

  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get('symbol') || '';
    if (!raw) return new Response(JSON.stringify({ error: 'missing symbol' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    const sym = mapSymbol(raw);
    const c = cache.get(sym);
    if (c && Date.now() - c.time < TTL) {
      return new Response(JSON.stringify({ symbol: sym, bars: c.data }), { headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } });
    }
    const bars = await fetchBars(sym);
    cache.set(sym, { data: bars, time: Date.now() });
    return new Response(JSON.stringify({ symbol: sym, bars }), { headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});

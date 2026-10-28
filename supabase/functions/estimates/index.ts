import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { dbGet, dbPut } from "../_shared/market_cache.ts";
import { type Estimate, fetchEstimates } from "../_shared/estimates.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const CACHE_KEY = 'est:v1';
const FRESH_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SYMBOLS = 250;

type Entry = Estimate & { ts: number };

const _rate = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 20;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const rl = _rate.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (rl.resetAt < now) { rl.count = 0; rl.resetAt = now + 60_000; }
  rl.count++;
  while (_rate.size > 4096) _rate.delete(_rate.keys().next().value as string);
  _rate.set(ip, rl);
  if (rl.count > RATE_LIMIT) return json({ error: 'Rate limit exceeded' }, 429);

  let body: { symbols?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const symbols = [...new Set((Array.isArray(body.symbols) ? body.symbols : [])
    .filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9.\-]{1,12}$/.test(s))
    .map((s) => s.toUpperCase()))];
  if (!symbols.length) return json({ error: 'missing symbols' }, 400);
  if (symbols.length > MAX_SYMBOLS) return json({ error: `at most ${MAX_SYMBOLS} symbols` }, 400);

  const cached = (await dbGet<Record<string, Entry>>(CACHE_KEY))?.data ?? {};
  const out: Record<string, Estimate> = {};
  const missing: string[] = [];
  for (const s of symbols) {
    const e = cached[s];
    if (e && now - e.ts < FRESH_MS) out[s] = { y0: e.y0, y1: e.y1 };
    else missing.push(s);
  }

  if (missing.length) {
    const fresh = await fetchEstimates(missing);
    Object.assign(out, fresh);
    if (Object.keys(fresh).length) {
      // Re-read before writing: another request may have stored its own symbols
      // since the read above, and overwriting would drop them.
      const latest = (await dbGet<Record<string, Entry>>(CACHE_KEY))?.data ?? {};
      const merged: Record<string, Entry> = {};
      for (const [s, e] of Object.entries(latest)) if (now - e.ts < KEEP_MS) merged[s] = e;
      for (const [s, e] of Object.entries(fresh)) merged[s] = { ...e, ts: now };
      await dbPut(CACHE_KEY, merged);
    }
  }
  return json(out);
});

export type Estimate = { y0: number | null; y1: number | null };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

type Trend = { period?: string; growth?: { raw?: unknown } };

export function parseTrend(json: unknown): Estimate | null {
  const trend = (json as { quoteSummary?: { result?: { earningsTrend?: { trend?: Trend[] } }[] } })
    ?.quoteSummary?.result?.[0]?.earningsTrend?.trend;
  if (!Array.isArray(trend)) return null;
  const pct = (period: string) => {
    const raw = trend.find((t) => t.period === period)?.growth?.raw;
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw * 10000) / 100 : null;
  };
  return { y0: pct('0y'), y1: pct('+1y') };
}

export function mapSymbol(sym: string): string {
  return sym.replace(/[./]/g, '-').toUpperCase().slice(0, 12);
}

let session: { cookie: string; crumb: string; at: number } | null = null;

async function getSession(f: typeof fetch, force = false) {
  if (session && !force && Date.now() - session.at < 30 * 60_000) return session;
  const r0 = await f('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = (r0.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const r1 = await f('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = await r1.text();
  if (!r1.ok || !crumb || crumb.length > 40 || /</.test(crumb)) throw new Error('yahoo crumb unavailable');
  session = { cookie, crumb, at: Date.now() };
  return session;
}

async function one(sym: string, f: typeof fetch): Promise<Estimate | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(f, attempt > 0);
    const r = await f(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(mapSymbol(sym))}?modules=earningsTrend&crumb=${encodeURIComponent(s.crumb)}`,
      { headers: { 'User-Agent': UA, Cookie: s.cookie }, signal: AbortSignal.timeout(8000) },
    );
    if (r.status === 401 || r.status === 403) continue;
    if (!r.ok) return null;
    return parseTrend(await r.json());
  }
  return null;
}

export async function fetchEstimates(symbols: string[], f: typeof fetch = fetch, concurrency = 8): Promise<Record<string, Estimate>> {
  const out: Record<string, Estimate> = {};
  let idx = 0;
  async function worker() {
    while (idx < symbols.length) {
      const sym = symbols[idx++];
      try {
        const e = await one(sym, f);
        if (e) out[sym] = e;
      } catch { /* one symbol failing must not sink the batch */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return out;
}

export function _resetSession() { session = null; }

// Shared market_cache access + stale-while-revalidate, used by scan-universe
// and ohlc. Ported from the trading-journal's _shared/swr.ts (2026-08-28
// fix there): a plain "if older than TTL, fetch" cache only stays warm under
// steady traffic. At this project's traffic a row is routinely older than its
// TTL, so every visit past it paid the full upstream fetch (TradingView scan,
// Yahoo bars) in the foreground. Serve the stale row immediately instead and
// refresh it behind the response — only a row older than maxStaleMs (or a
// missing one) still blocks on a real fetch, because past that bound the data
// is too old to show.

// Read lazily, not at module load: a test that only exercises serveCached()
// via an injected io never calls these, and should not need --allow-env just
// because this module happens to be imported.
function sbEnv() {
  return { url: Deno.env.get('SUPABASE_URL') || '', key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '' };
}

export async function dbGet<T>(key: string): Promise<{ data: T; age: number } | null> {
  const { url, key: apiKey } = sbEnv();
  if (!url || !apiKey) return null;
  try {
    const r = await fetch(
      `${url}/rest/v1/market_cache?cache_key=eq.${encodeURIComponent(key)}&select=payload,refreshed_at`,
      { headers: { apikey: apiKey, Authorization: 'Bearer ' + apiKey } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return { data: rows[0].payload as T, age: Date.now() - new Date(rows[0].refreshed_at).getTime() };
  } catch { return null; }
}

export async function dbPut(key: string, data: unknown): Promise<void> {
  const { url, key: apiKey } = sbEnv();
  if (!url || !apiKey) return;
  try {
    await fetch(`${url}/rest/v1/market_cache`, {
      method: 'POST',
      headers: {
        apikey: apiKey, Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ cache_key: key, payload: data, refreshed_at: new Date().toISOString() }),
    });
  } catch { /* best-effort */ }
}

// `io` defaults to the real market_cache table but takes an injected
// get/put pair in tests, so the SWR contract can be verified without a
// live Supabase project or network access.
export async function serveCached<T>(
  key: string,
  ttlMs: number,
  maxStaleMs: number,
  refresh: () => Promise<T>,
  io: { get: (key: string) => Promise<{ data: T; age: number } | null>; put: (key: string, data: T) => Promise<void> } = { get: dbGet, put: dbPut },
): Promise<{ data: T; src: 'DB' | 'STALE' | 'LIVE' }> {
  const cached = await io.get(key);
  if (cached && cached.age < ttlMs) return { data: cached.data, src: 'DB' };

  if (cached && cached.age < maxStaleMs) {
    // Detached on purpose: waitUntil keeps the isolate alive for the refresh
    // without the caller waiting on it. A failure here is not the caller's
    // problem — they already have a usable payload.
    const p = refresh()
      .then((fresh) => io.put(key, fresh))
      .catch((e) => { console.error(`[${key}] background refresh failed:`, e); });
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
    return { data: cached.data, src: 'STALE' };
  }

  try {
    const fresh = await refresh();
    io.put(key, fresh);
    return { data: fresh, src: 'LIVE' };
  } catch (e) {
    if (cached) return { data: cached.data, src: 'STALE' };
    throw e;
  }
}

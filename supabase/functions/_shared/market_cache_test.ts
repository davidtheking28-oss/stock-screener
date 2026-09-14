// Guards the stale-while-revalidate contract. The failure this protects
// against is silent: flip a comparison or drop the waitUntil and everything
// still works, it just goes back to paying the cold fetch (TradingView scan,
// Yahoo bars) in the foreground on every visit past the TTL — precisely the
// state this replaced. See the journal's swr_test.ts, which this mirrors.
//
// Run: deno test supabase/functions/_shared/market_cache_test.ts
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { serveCached } from './market_cache.ts';

const waited: Promise<unknown>[] = [];
(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => waited.push(p) };

function fakeIo(cached: { data: { v: string }; age: number } | null) {
  const puts: unknown[] = [];
  return {
    io: {
      get: () => Promise.resolve(cached),
      put: (_key: string, data: { v: string }) => { puts.push(data); return Promise.resolve(); },
    },
    puts,
  };
}
const TTL = 5 * 60_000;
const MAX = 20 * 60_000;
const fresh = async () => ({ v: 'FRESH' });

Deno.test('a fresh row is served without refreshing at all', async () => {
  let calls = 0;
  const { io } = fakeIo({ data: { v: 'CACHED' }, age: 60_000 });
  const r = await serveCached('k', TTL, MAX, async () => { calls++; return { v: 'FRESH' }; }, io);
  assertEquals(r, { data: { v: 'CACHED' }, src: 'DB' });
  assertEquals(calls, 0);
});

Deno.test('a stale row is returned immediately and refreshed behind the response', async () => {
  waited.length = 0;
  // The refresh is held open until after serveCached has returned. If the
  // implementation ever awaits it, this test deadlocks rather than passing —
  // the only honest way to assert "the caller did not wait".
  let release!: (v: { v: string }) => void;
  const held = new Promise<{ v: string }>((res) => { release = res; });
  let finished = false;

  const { io, puts } = fakeIo({ data: { v: 'CACHED' }, age: 10 * 60_000 });
  const r = await serveCached('k', TTL, MAX, () => held, io);

  assertEquals(r, { data: { v: 'CACHED' }, src: 'STALE' });
  assertEquals(finished, false);
  assertEquals(waited.length, 1);

  release({ v: 'FRESH' });
  await Promise.all(waited);
  finished = true;
  assertEquals(finished, true);
  assertEquals(puts, [{ v: 'FRESH' }]);
});

Deno.test('past the staleness bound it blocks on a real fetch', async () => {
  const { io } = fakeIo({ data: { v: 'CACHED' }, age: 30 * 60_000 });
  const r = await serveCached('k', TTL, MAX, fresh, io);
  assertEquals(r, { data: { v: 'FRESH' }, src: 'LIVE' });
});

Deno.test('a missing row blocks on a real fetch', async () => {
  const { io } = fakeIo(null);
  const r = await serveCached('k', TTL, MAX, fresh, io);
  assertEquals(r, { data: { v: 'FRESH' }, src: 'LIVE' });
});

Deno.test('a background refresh that throws still leaves the caller a payload', async () => {
  waited.length = 0;
  const { io } = fakeIo({ data: { v: 'CACHED' }, age: 10 * 60_000 });
  const r = await serveCached('k', TTL, MAX, async (): Promise<{ v: string }> => { throw new Error('upstream down'); }, io);
  assertEquals(r, { data: { v: 'CACHED' }, src: 'STALE' });
  await Promise.all(waited);
});

Deno.test('no row and a failed live fetch throws for the caller to handle', async () => {
  const { io } = fakeIo(null);
  let threw = false;
  try {
    await serveCached('k', TTL, MAX, async (): Promise<{ v: string }> => { throw new Error('upstream down'); }, io);
  } catch { threw = true; }
  assertEquals(threw, true);
});

Deno.test('too-stale but a failed live fetch falls back to the cached row', async () => {
  const { io } = fakeIo({ data: { v: 'CACHED' }, age: 30 * 60_000 });
  const r = await serveCached('k', TTL, MAX, async (): Promise<{ v: string }> => { throw new Error('upstream down'); }, io);
  assertEquals(r, { data: { v: 'CACHED' }, src: 'STALE' });
});

import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { _resetSession, fetchEstimates, mapSymbol, parseTrend } from './estimates.ts';

const trend = (g0: unknown, g1: unknown) => ({ quoteSummary: { result: [{ earningsTrend: { trend: [
  { period: '0q', growth: { raw: 0.9 } }, { period: '0y', growth: { raw: g0 } }, { period: '+1y', growth: { raw: g1 } },
] } }] } });

Deno.test('parseTrend reads this year and next year as percent', () => {
  const e = parseTrend(trend(0.952, 0.709));
  assert(e?.y0 === 95.2 && e?.y1 === 70.9);
});

Deno.test('a missing or non-numeric growth is null, never zero', () => {
  const e = parseTrend(trend(undefined, 'x'));
  assert(e && e.y0 === null && e.y1 === null);
});

Deno.test('a body with no trend is not an estimate', () => {
  assert(parseTrend({}) === null && parseTrend(null) === null);
});

Deno.test('share classes use the dash Yahoo expects', () => {
  assert(mapSymbol('brk.b') === 'BRK-B');
});

Deno.test('one failing symbol does not sink the batch, and a 401 retries with a fresh crumb', async () => {
  _resetSession();
  let crumbCalls = 0;
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return new Response('', { headers: { 'set-cookie': 'A=1; Path=/' } });
    if (u.includes('getcrumb')) return new Response('crumb' + (++crumbCalls));
    if (u.includes('BAD')) return new Response('nope', { status: 500 });
    if (u.includes('GOOD') && u.includes('crumb1')) return new Response('', { status: 401 });
    return new Response(JSON.stringify(trend(0.5, 0.3)));
  }) as typeof fetch;
  const out = await fetchEstimates(['GOOD', 'BAD'], f, 1);
  assert(out.GOOD?.y0 === 50 && out.GOOD?.y1 === 30 && !('BAD' in out) && crumbCalls === 2);
});

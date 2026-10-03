import { assertEquals } from 'jsr:@std/assert@1';
import { buildWatchlistAlert } from './alert.ts';

const near = new Map([['AAA', { pivot: 100, distPct: -0.5 }], ['BBB', { pivot: 50, distPct: -4 }], ['ZZZ', { pivot: 10, distPct: -1 }]]);

Deno.test('alert: lists only watchlist names, closest to the pivot first', () => {
  const m = buildWatchlistAlert('2026-10-03', near, [], [], new Set(['BBB', 'AAA']))!;
  assertEquals(m.includes('ZZZ'), false);
  assertEquals(m.indexOf('AAA') < m.indexOf('BBB'), true);
});

Deno.test('alert: nothing to say means no message', () => {
  assertEquals(buildWatchlistAlert('2026-10-03', near, ['QQQ'], ['RRR'], new Set(['AAA2'])), null);
});

Deno.test('alert: watchlist entries and exits are reported even with nothing near the pivot', () => {
  const m = buildWatchlistAlert('2026-10-03', new Map(), ['AAA'], ['BBB'], new Set(['AAA', 'BBB']))!;
  assertEquals(m.includes('נכנסו לסינון: AAA') && m.includes('יצאו מהסינון: BBB'), true);
});

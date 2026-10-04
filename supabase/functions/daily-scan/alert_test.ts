import { assertEquals } from 'jsr:@std/assert@1';
import { buildPivotAlert, nearItems } from './alert.ts';

const near = new Map([['AAA', { pivot: 100, distPct: -0.5 }], ['BBB', { pivot: 50, distPct: -2.5 }], ['ZZZ', { pivot: 10, distPct: -1 }]]);

Deno.test('nearItems: only names near their pivot, closest first, and star marks the watchlist', () => {
  const r = nearItems(['BBB', 'AAA', 'NOPE'], near, new Set(['AAA']));
  assertEquals(r.map(i => i.t), ['AAA', 'BBB']);
  assertEquals(r.map(i => !!i.star), [true, false]);
});

Deno.test('alert: groups appear in the order given, each under its own title and scan date', () => {
  const m = buildPivotAlert('2026-10-03', [
    { title: 'רשימת מעקב', items: nearItems(['AAA'], near) },
    { title: 'VCP / פריצה', asOf: '2026-10-03', items: nearItems(['BBB'], near) },
  ], [], [], 3)!;
  assertEquals(m.indexOf('רשימת מעקב') < m.indexOf('VCP / פריצה'), true);
  assertEquals(m.includes('VCP / פריצה (סריקה מ-2026-10-03)'), true);
  assertEquals(m.includes('עד 3%'), true);
});

Deno.test('alert: an empty group is left out entirely', () => {
  const m = buildPivotAlert('2026-10-03', [{ title: 'ריק', items: [] }, { title: 'מלא', items: nearItems(['AAA'], near) }], [], [], 3)!;
  assertEquals(m.includes('ריק'), false);
});

Deno.test('alert: nothing to say means no message', () => {
  assertEquals(buildPivotAlert('2026-10-03', [{ title: 'x', items: [] }], [], [], 3), null);
});

Deno.test('alert: a long group is capped and says how many were left out', () => {
  const big = new Map(Array.from({ length: 20 }, (_, i) => ['T' + i, { pivot: 10, distPct: -1 - i * 0.05 }] as [string, { pivot: number; distPct: number }]));
  const m = buildPivotAlert('2026-10-03', [{ title: 'g', items: nearItems(big.keys(), big) }], [], [], 3)!;
  assertEquals(m.includes('ועוד 8'), true);
});

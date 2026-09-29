import { assertEquals, assertAlmostEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { approachingPivot } from './pivot.ts';

const flat = (n: number, h: number, c: number) => Array.from({ length: n }, (_, i) => ({ t: i, h, c }));

Deno.test('approachingPivot: just under the base high is approaching', () => {
  const bars = [...flat(60, 100, 95), { t: 60, h: 99, c: 97 }];
  const r = approachingPivot(bars)!;
  assertEquals(r.pivot, 100);
  assertAlmostEquals(r.distPct, -3, 0.001);
});

Deno.test('approachingPivot: already above the base high is a breakout, not approaching', () => {
  const bars = [...flat(60, 100, 95), { t: 60, h: 106, c: 105 }];
  assertEquals(approachingPivot(bars), null);
});

Deno.test('approachingPivot: too far below the pivot is not approaching', () => {
  const bars = [...flat(60, 100, 95), { t: 60, h: 90, c: 88 }];
  assertEquals(approachingPivot(bars), null);
});

Deno.test('approachingPivot: the current bar never counts toward its own pivot', () => {
  const bars = [...flat(60, 100, 95), { t: 60, h: 200, c: 96 }];
  assertEquals(approachingPivot(bars)!.pivot, 100);
});

Deno.test('approachingPivot: too little history returns null', () => {
  assertEquals(approachingPivot(flat(10, 100, 99)), null);
  assertEquals(approachingPivot(null), null);
});

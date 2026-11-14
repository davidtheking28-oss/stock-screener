import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { newEntries, forwardReturns, isSplitLike } from './entries.ts';

const night = (...t: string[]) => ({ tickers: t.map(x => ({ t: x })) });

Deno.test('newEntries: a name that was in yesterday\'s list is not new', () => {
  assertEquals(newEntries(['AAA', 'BBB'], [night('AAA')]), ['BBB']);
});

Deno.test('newEntries: a name that dropped out and came back within 5 nights is not new', () => {
  const prev = [night('X'), night('MU'), night('X'), night('X'), night('X')];
  assertEquals(newEntries(['MU'], prev), []);
});

Deno.test('newEntries: a name last seen more than 5 nights ago is new again', () => {
  const prev = [night('X'), night('X'), night('X'), night('X'), night('X'), night('MU')];
  assertEquals(newEntries(['MU'], prev), ['MU']);
});

Deno.test('newEntries: the first ever scan has no history, so nothing is an entry', () => {
  assertEquals(newEntries(['AAA'], []), []);
});

Deno.test('isSplitLike: halving, thirding and a 10:1 split are split-sized, real moves are not', () => {
  assertEquals(isSplitLike(82.07 / 163.18), true);
  assertEquals(isSplitLike(1 / 3), true);
  assertEquals(isSplitLike(0.1), true);
  assertEquals(isSplitLike(0.93), false);
  assertEquals(isSplitLike(1.4), false);
  assertEquals(isSplitLike(0.7), false);
});

Deno.test('forwardReturns: a 2:1 split is not booked as a 50% loss', () => {
  const then = new Map([['APH', 163.18], ['OK', 100]]);
  const now = new Map([['APH', 82.07], ['OK', 110]]);
  assertEquals(forwardReturns(['APH', 'OK'], then, now), [10.000000000000009]);
});

Deno.test('forwardReturns: a name with no price now or then is skipped', () => {
  assertEquals(forwardReturns(['A', 'B'], new Map([['A', 10]]), new Map([['B', 11]])), []);
});

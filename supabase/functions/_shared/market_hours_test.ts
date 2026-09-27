import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { lastUsCloseMs, oneYearBarsPolicy, usMarketOpen } from "./market_hours.ts";

// September 2026 is EDT (UTC-4): 16:15 ET = 20:15Z.
const z = (s: string) => Date.parse(s + "Z");

Deno.test("usMarketOpen: regular hours plus the 15-min finalization buffer", () => {
  assertEquals(usMarketOpen(z("2026-09-22T14:00:00")), true);  // Tue 10:00 ET
  assertEquals(usMarketOpen(z("2026-09-22T20:10:00")), true);  // Tue 16:10 ET
  assertEquals(usMarketOpen(z("2026-09-22T21:00:00")), false); // Tue 17:00 ET
  assertEquals(usMarketOpen(z("2026-09-26T16:00:00")), false); // Saturday
});

Deno.test("lastUsCloseMs: the most recent weekday 16:15 ET at or before now", () => {
  assertEquals(lastUsCloseMs(z("2026-09-26T16:00:00")), z("2026-09-25T20:15:00")); // Sat → Fri
  assertEquals(lastUsCloseMs(z("2026-09-22T14:00:00")), z("2026-09-21T20:15:00")); // Tue open → Mon
  assertEquals(lastUsCloseMs(z("2026-09-22T21:00:00")), z("2026-09-22T20:15:00")); // Tue evening → Tue
  assertEquals(lastUsCloseMs(z("2026-09-21T12:00:00")), z("2026-09-18T20:15:00")); // Mon pre-market → Fri
});

// The bug this guards: a 1y snapshot taken mid-session (partial last candle,
// low volume) used to stay "fresh" for 6h and servable for 24h, so an evening
// scan judged "volume falling day after day" on a half-finished day.
Deno.test("oneYearBarsPolicy: nothing from before the last close is fresh or servable", () => {
  const sat = z("2026-09-26T16:00:00"), sinceFri = sat - z("2026-09-25T20:15:00");
  const p = oneYearBarsPolicy(sat);
  assertEquals(p.ttl, sinceFri);
  assertEquals(p.maxStale, sinceFri);
  const tue = z("2026-09-22T14:00:00"), sinceMon = tue - z("2026-09-21T20:15:00");
  const q = oneYearBarsPolicy(tue);
  assertEquals(q.ttl, 6 * 60 * 60 * 1000); // intraday: refresh the live bar every 6h at most
  assertEquals(q.maxStale, sinceMon);
});

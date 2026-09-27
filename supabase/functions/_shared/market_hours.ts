// US regular session, 9:30–16:15 ET. The extra 15 minutes past the bell give
// Yahoo time to finalize the day's daily bar. Holidays are not modelled; one
// just costs an extra upstream fetch.
const OPEN_MIN = 9 * 60 + 30, CLOSE_MIN = 16 * 60 + 15;
const ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
});

function etParts(ms: number) {
  const p = Object.fromEntries(ET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekend: p.weekday === "Sat" || p.weekday === "Sun", min: (+p.hour % 24) * 60 + +p.minute };
}

export function usMarketOpen(ms: number): boolean {
  const { weekend, min } = etParts(ms);
  return !weekend && min >= OPEN_MIN && min < CLOSE_MIN;
}

export function lastUsCloseMs(now: number): number {
  let t = now - (now % 60000) - etParts(now).min * 60000 + CLOSE_MIN * 60000;
  while (t > now || etParts(t).weekend) t -= 86400000;
  return t;
}

// A 1y snapshot taken before the last close holds a half-finished candle (and
// its low partial volume) for that session, so it is neither fresh nor
// servable-while-stale once the session has closed. Intraday, the live bar is
// refreshed every 6h at most.
export function oneYearBarsPolicy(now: number) {
  const sinceClose = now - lastUsCloseMs(now);
  return {
    ttl: usMarketOpen(now) ? Math.min(6 * 60 * 60 * 1000, sinceClose) : sinceClose,
    maxStale: sinceClose,
    lastClose: now - sinceClose,
  };
}

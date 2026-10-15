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

const ET_FULL = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", hour12: false,
});
function etWall(ms: number) {
  const p = Object.fromEntries(ET_FULL.formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
}
// The instant at which New York's wall clock reads `minOfDay` on the calendar day
// `daysBack` before today's ET date. Subtracting 86400000 instead lands an hour off
// in the week the clocks change, which put "the last close" at 15:15 ET.
function etInstant(now: number, daysBack: number, minOfDay: number): number {
  const nowWall = etWall(now);
  const target = nowWall - (nowWall % 86400000) - daysBack * 86400000 + minOfDay * 60000;
  let t = now + (target - nowWall);
  t += target - etWall(t);
  return t + (target - etWall(t));
}
function lastEdgeBefore(now: number, minOfDay: number): number {
  for (let d = 0; d < 10; d++) {
    const t = etInstant(now, d, minOfDay);
    if (t <= now && !etParts(t).weekend) return t;
  }
  return now;
}

export function lastUsCloseMs(now: number): number {
  return lastEdgeBefore(now, CLOSE_MIN);
}

// The most recent session edge: the open (with two minutes of grace for the feed to
// start the day's bar) or the close above. A row refreshed before it was taken in
// the wrong session — before the open it still ends on yesterday, mid-session it
// holds a half-finished candle — so it must not be served ahead of a refresh.
export function lastUsOpenMs(now: number): number {
  return lastEdgeBefore(now, OPEN_MIN + 2);
}
export function lastSessionEdgeMs(now: number): number {
  return Math.max(lastUsCloseMs(now), lastUsOpenMs(now));
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

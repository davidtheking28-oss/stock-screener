# Project: SEPA Stock Screener

## What it is
Single-file Minervini SEPA / Trend Template stock screener, Hebrew RTL. Runs
standalone at `https://davidtheking28-oss.github.io/stock-screener/` **and**
embedded as an iframe inside the trading journal (`c:/Users/david/trading-journal/dashboard.html`,
`#screener-frame`) — the iframe always points at the live production URL, so a
local edit does nothing anywhere else until it's pushed.

**Repo:** `C:\Users\david\stock-screener\` (local) | `davidtheking28-oss/stock-screener` (GitHub)

**No auto-push hook here** — unlike the trading-journal repo, changes must be
committed and pushed manually (`git add -A && git commit ... && git push origin main`)
for GitHub Pages to redeploy. Confirm the deploy actually landed before telling
the user it's fixed — poll `https://davidtheking28-oss.github.io/stock-screener/`
for the change rather than assuming push = live.

---

## ⚠️ Don't reintroduce these regressions (fixed 2026-08-11)

- **`loadUserData()` must not unconditionally `render()`.** It runs on every
  page load; `loadResultsCache()` has already drawn the table synchronously by
  the time it resolves. An unconditional rebuild here is a second, visible
  render pass a beat after the first — reads as "the screener reloading the
  stocks from scratch" on every visit. Only rebuild when the fetched watchlist
  or column prefs actually differ from what's already rendered (diff before
  redraw, not after).
- **Stale cached results (`loadResultsCache`, `stale` flag) must not
  auto-trigger `scan(true)`.** A page reload with a >30-min-old cache used to
  kick off a full market re-scan 600ms after load with no way to decline —
  losing the user's scroll position and place in the results every time the
  browser discarded and reloaded a backgrounded tab. Offer a one-click refresh
  instead (`_saveScroll`/`_restoreScroll` handle putting the user back where
  they were).
- **Filter inputs must save on every `input`/`change`, not only after a
  completed scan or preset click.** An edit made and then interrupted (get
  called away, navigate elsewhere) used to be silently lost, reverting to
  whatever was last scanned.
- **Scroll position lives on `#tableView`, not `window`** — the results table
  scrolls internally. Any scroll-restore logic has to target both.

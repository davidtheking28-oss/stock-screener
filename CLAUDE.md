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

## Tests
`py tests/run-tests.py` — loads the page in headless Chromium and asserts against
the **real in-page functions** (`applyFilters`, `computeRS`, `calcScore`, `SORTS`,
`_vcp`, `_rsLine`, `_ma200Rising`, `_powerPlayOK`), so there are no copies to
drift. Deterministic synthetic fixtures, no network. Setup once:
`py -m pip install playwright && py -m playwright install chromium`.

It is a required job in `.github/workflows/deploy.yml` — a red test blocks the
Pages deploy.

Run it after touching `applyFilters`, `computeRS`, `calcScore`, `SORTS`, the
`FIELD_PRESETS`/`SCREENER_DEFAULTS` tables, or the prefs migration chain. **Every
fix to filter or scoring logic belongs in `tests/assertions.js`, and the test must
be shown to fail when the fix is reverted.**

Two traps this suite has already caught:
- **A new default-ON toggle breaks unrelated fixtures.** The SEPA Trend-Template
  fixture disables every fundamental gate by name; adding `requireRevAccel`
  (default on) without adding it to that list turned the result set empty.
  Keep the disable list in that test in sync with the toggles in the HTML.
- **`daily-scan` reimplements the SEPA gates in TypeScript** and had silently
  drifted on five separate parameters. A test pins the client-side defaults so
  the divergence is visible — when you change a SEPA default, change
  `supabase/functions/daily-scan/index.ts` in the same commit.

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

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

## ⚠️ Don't reintroduce these regressions (fixed 2026-08-23)

Full criteria audit against the real Minervini / Qullamaggie definitions, with
a live 5,545-name scan used to measure each change before it shipped.

- **`daily-scan` reimplements `calcScore` too, and only the *filters* were
  pinned.** Its score sat at RS 40 / EPS 25 / rev 20 / high 15 long after the
  client moved to 35 / 25 / 15 / 15 + a 10-point `Perf.Y` term, and it still
  carried the `clamp(eps,0,300)` floor that scores a wiped-out -268% YoY the
  same as flat 0%. The nightly email therefore ranked the same day's results
  differently from the app. Both halves are now pinned term-by-term
  (`SEPA score: RS is worth 35`, …) — **a weight change fails the suite until
  `daily-scan` changes with it.** It also had no earnings-date gate at all.
- **Criterion #3 must not be enforced twice with two different tests.**
  `Perf.6M>0` in `applyFilters` was standing in for "SMA200 rising", but
  `validateExact` already runs the real slope (`_ma200Rising`) — the proxy was
  only rejecting names before the real check saw them. The proxy now runs only
  where the exact check cannot: no Supabase (no bars) or the `skipFund` pass
  that builds `ttUniverse` synchronously. **Do not delete that fallback** —
  `_ma200Rising` returns `null` for <222 bars, and without it criterion #3
  silently disappears for short-history names.
- **`_powerPlayOK`'s duration guard.** Checking only the drawdown depth passed
  a stock that peaked yesterday: nothing had happened since the high, so it
  looked maximally *tight*. Measured live — of 25 names passing on depth, **24
  had 0-8 bars since their run high**. Minervini's literal 3-4 weeks leaves
  exactly 1 result, so the threshold is the `consolWeeks` field (default 2
  weeks = 10 bars, "3 שבועות — מינרוויני" in the dropdown). Live after: 5.
- **The `growth` branch of `calcScore` was the one the ranking fix never
  reached.** Scoring on `epsQoq`/`revQoq` alone put BATRA (RS 62, year +23%,
  EPS YoY **-140%**) first and MU (RS 98, +726%, +1372%) third. QoQ still holds
  the majority (30+25) with RS 15 / `Perf.Y` 15 / EPS YoY 15 behind it.
  Every term is pinned individually — a combined assertion missed a dropped
  term during mutation testing.
- **Qullamaggie's thresholds were `move3Min:10` / `move6Min:20`** — he screens
  the market's *biggest gainers*, not anything that moved. Now 20/30 (v5
  migration, only-migrate-the-old-default). Live: 147 → 107.
- **`requireVCP` is off by default and that is deliberate.** `_vcp` was fully
  implemented but purely decorative, so the screener found Trend Template +
  fundamentals, never an actual base. Gating on it live takes 11 → 5. It is a
  setup filter, not a screen-wide criterion.
- **`GROWTH_SECTORS` was missing `Health Technology`** — biotech/pharma, where
  a large share of the fastest quarterly growers sit, was excluded from the one
  screener whose entire thesis is growth. Live: 70 → 85.
- **The VCP gate has no unit test.** It lives in `validateExact`, which needs
  Supabase and network; the headless suite runs off the raw local file where
  `HAS_SUPABASE` is false. It was verified in the browser against the live
  deploy instead (11 → 5, every survivor `contractions>=2 && tighteningOK`).
  A mutation deleting that line does **not** turn the suite red — check it by
  hand when touching `validateExact`.
- **Known, deliberate approximation: `computeRS` is not IBD's RS.** It ranks
  `0.4×Perf.3M + 0.3×Perf.6M + 0.3×Perf.Y` by percentile within the scanned
  universe; IBD weights four quarters 40/20/20/20 against the whole market. A
  name can be RS 72 here and 68 there. Not fixable without an IBD feed — don't
  "correct" it into a different arbitrary formula.

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

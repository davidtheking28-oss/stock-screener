import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { COLUMNS, C, FILTERS, Row, computeRS, applyClassicSEPA } from './scoring.ts';
import { approachingPivot, Bar } from './pivot.ts';
import { buildPivotAlert, nearItems, SCREENER_TITLES, SCREENER_ORDER, NearPivot } from './alert.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'SEPA Screener <onboarding@resend.dev>';

async function sb(path: string, init: RequestInit = {}) {
  return fetch(`${SB_URL}${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
}

async function scanQuery(typeFilter: Record<string, unknown>, primaryOnly: boolean): Promise<Row[]> {
  const body = {
    columns: COLUMNS,
    filter: [
      typeFilter,
      ...(primaryOnly ? [{ left: "is_primary", operation: "equal", right: true }] : []),
      { left: "close", operation: "egreater", right: 2 },
      { left: "market_cap_basic", operation: "egreater", right: 50000000 },
      // Mirrors the client-side fetchUniverse() OTC exclusion (2026-08-26) —
      // this scan feeds the nightly job, so it needs the same filter or OTC
      // names quietly come back in through here.
      { left: "exchange", operation: "in_range", right: ["AMEX", "NASDAQ", "NYSE"] },
    ],
    markets: ["america"],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    range: [0, 8000],
  };
  const res = await fetch('https://scanner.tradingview.com/america/scan?label-product=screener-stock',
    { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('TradingView ' + res.status);
  return (await res.json()).data || [];
}

// Mirrors the client's two-query universe: ADRs are type "dr" and mostly
// is_primary=false (their primary listing is the home exchange), so a single
// type=stock+is_primary query silently omits TSM/ASML/NVO/SAP/TM and ~1300
// others, while that guard still has to apply to US dual-class names.
async function fetchUniverse(): Promise<Row[]> {
  const [stocks, drs] = await Promise.all([
    scanQuery({ left: "type", operation: "equal", right: "stock" }, true),
    scanQuery({ left: "type", operation: "equal", right: "dr" }, false).catch(() => [] as Row[]),
  ]);
  const seen = new Set(stocks.map(r => r.s));
  return stocks.concat(drs.filter(r => !seen.has(r.s)));
}

async function fetchBars(symbol: string): Promise<Bar[] | null> {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/ohlc?symbol=${encodeURIComponent(symbol)}&range=3mo`, {
      headers: { Authorization: 'Bearer ' + SB_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d?.bars) ? d.bars : null;
  } catch { return null; }
}

// The email path needs RESEND_API_KEY, which this project has never had set, so
// the nightly mail silently went nowhere. Telegram needs only secrets that
// already exist (the data-health bot), so the owner's watchlist alert goes there.
const TG_MAX_PCT = 3;

async function sendTelegramAlert(scanDate: string, entries: string[], exits: string[]) {
  const sr = await sb('/rest/v1/app_secrets?select=key,value&key=in.(telegram_bot_token,telegram_chat_id,telegram_owner_user_id)');
  if (!sr.ok) return { sent: 0, reason: 'secrets ' + sr.status };
  const sec = Object.fromEntries(((await sr.json()) as { key: string; value: string }[]).map(r => [r.key, r.value]));
  if (!sec.telegram_bot_token || !sec.telegram_chat_id || !sec.telegram_owner_user_id) return { sent: 0, reason: 'telegram not configured' };
  const owner = encodeURIComponent(sec.telegram_owner_user_id);
  // Only the last 4 days: the table holds thousands of rows per user and the API
  // returns at most 1000, which silently truncated the lists to a fraction.
  const cutoff = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const [wr, hr] = await Promise.all([
    sb(`/rest/v1/screener_watchlist?select=ticker&user_id=eq.${owner}`),
    sb(`/rest/v1/screener_history?select=ticker,screener,last_seen&user_id=eq.${owner}&last_seen=gte.${cutoff}&order=last_seen.desc&limit=1000`),
  ]);
  if (!wr.ok) return { sent: 0, reason: 'watchlist ' + wr.status };
  const wl = new Set(((await wr.json()) as { ticker: string }[]).map(r => r.ticker));
  // screener_history holds, per screener, the tickers that passed each scan the
  // owner ran in the app. A screener's CURRENT list is the rows stamped with its
  // newest last_seen; one not scanned for 4+ days is stale and left out rather
  // than reported as if it were today's.
  const hist = hr.ok ? ((await hr.json()) as { ticker: string; screener: string; last_seen: string }[]) : [];
  const newest: Record<string, string> = {};
  for (const h of hist) if (!newest[h.screener] || h.last_seen > newest[h.screener]) newest[h.screener] = h.last_seen;
  const byScreener: Record<string, string[]> = {};
  for (const h of hist) {
    if (SCREENER_TITLES[h.screener] && h.last_seen === newest[h.screener]) (byScreener[h.screener] ||= []).push(h.ticker);
  }
  const wanted = [...wl, ...SCREENER_ORDER.flatMap(k => byScreener[k] || [])];
  const tickers = [...new Set(wanted)];
  const near = new Map<string, NearPivot>();
  // The shared ohlc function is limited to 400 requests a minute per IP, so
  // batches are paced; the watchlist goes first and the deadline cuts the tail.
  const deadline = Date.now() + 100_000;
  for (let i = 0; i < tickers.length && Date.now() < deadline; i += 8) {
    const t0 = Date.now();
    await Promise.all(tickers.slice(i, i + 8).map(async t => {
      const r = approachingPivot(await fetchBars(t), -TG_MAX_PCT);
      if (r) near.set(t, r);
    }));
    const wait = 1500 - (Date.now() - t0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  const groups = [
    { title: 'רשימת מעקב', items: nearItems(wl, near) },
    ...SCREENER_ORDER.filter(k => byScreener[k]).map(k => ({
      title: SCREENER_TITLES[k], asOf: newest[k], items: nearItems(byScreener[k], near, wl),
    })),
  ];
  const text = buildPivotAlert(scanDate, groups, entries.filter(t => wl.has(t)), exits.filter(t => wl.has(t)), TG_MAX_PCT);
  if (!text) return { sent: 0, reason: 'nothing to report', checked: tickers.length };
  const tr = await fetch(`https://api.telegram.org/bot${sec.telegram_bot_token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: sec.telegram_chat_id, text: text.slice(0, 4000) }),
  });
  return tr.ok ? { sent: 1, near: near.size, checked: tickers.length } : { sent: 0, reason: 'telegram ' + tr.status };
}

async function sendEmails(scanDate: string, entries: string[], exits: string[], results: ReturnType<typeof applyClassicSEPA>, breadth: number) {
  if (!RESEND_KEY) return { sent: 0, reason: 'no RESEND_API_KEY' };
  const usersRes = await sb('/auth/v1/admin/users?per_page=200');
  if (!usersRes.ok) return { sent: 0, reason: 'admin users ' + usersRes.status };
  const allUsers: { id: string; email: string }[] = ((await usersRes.json()).users || []).filter((u: { email?: string }) => u.email);
  const wlRes = await sb('/rest/v1/screener_watchlist?select=user_id,ticker');
  const wlRows: { user_id: string; ticker: string }[] = wlRes.ok ? await wlRes.json() : [];
  // auth.users is shared across every app on this Supabase project (this
  // screener AND the sibling trading-journal), so mailing every signed-in
  // user sent nightly SEPA scan results to journal-only accounts that never
  // opened the screener. Scope to users with an actual screener footprint —
  // any row in a screener-specific table proves real usage, so this is a
  // fact check, not a preference call. wlRows is already fetched above.
  const [prefsRes, histRes, visitRes] = await Promise.all([
    sb('/rest/v1/screener_prefs?select=user_id'),
    sb('/rest/v1/screener_history?select=user_id'),
    sb('/rest/v1/screener_type_visits?select=user_id'),
  ]);
  const screenerUserIds = new Set<string>([
    ...wlRows.map(w => w.user_id),
    ...(prefsRes.ok ? (await prefsRes.json()) as { user_id: string }[] : []).map(r => r.user_id),
    ...(histRes.ok ? (await histRes.json()) as { user_id: string }[] : []).map(r => r.user_id),
    ...(visitRes.ok ? (await visitRes.json()) as { user_id: string }[] : []).map(r => r.user_id),
  ]);
  const users = allUsers.filter(u => screenerUserIds.has(u.id));
  const top = results.slice(0, 10);
  const userIds = new Set(users.map(u => u.id));
  const wlTickers = [...new Set(wlRows.filter(w => userIds.has(w.user_id)).map(w => w.ticker))];
  const approaching = new Map<string, { pivot: number; distPct: number }>();
  const barsDeadline = Date.now() + 60_000;
  for (let i = 0; i < wlTickers.length && Date.now() < barsDeadline; i += 10) {
    await Promise.all(wlTickers.slice(i, i + 10).map(async t => {
      const r = approachingPivot(await fetchBars(t));
      if (r) approaching.set(t, r);
    }));
  }
  let sent = 0;
  for (const u of users) {
    const wl = new Set(wlRows.filter(w => w.user_id === u.id).map(w => w.ticker));
    const wlEnt = entries.filter(t => wl.has(t)), wlEx = exits.filter(t => wl.has(t));
    const wlNear = [...wl].filter(t => approaching.has(t)).sort((a, b) => approaching.get(b)!.distPct - approaching.get(a)!.distPct);
    const mark = (t: string) => wl.has(t) ? `<b style="color:#b45309">★${t}</b>` : t;
    const list = (a: string[]) => a.map(mark).join(', ') || '—';
    const html = `<!DOCTYPE html><html dir="rtl" lang="he"><body style="font-family:Arial,sans-serif;background:#f5f7fb;padding:24px;color:#1a2433">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #e3e9f2">
<h2 style="margin:0 0 4px">SEPA Screener — סריקת לילה ${scanDate}</h2>
<p style="color:#5b6b85;margin:0 0 18px">רוחב שוק: ${breadth}% מהמניות במגמת עלייה · ${results.length} מניות עוברות את הסינון</p>
${wlNear.length ? `<div style="background:#eefaf1;border:1px solid #bfe3c9;border-radius:10px;padding:12px 16px;margin-bottom:16px"><b>מתקרבות ל-Pivot ברשימת המעקב שלך:</b><br><span dir="ltr">${wlNear.map(t => `<b>${t}</b> ${approaching.get(t)!.distPct.toFixed(1)}%`).join(' · ')}</span></div>` : ''}
${wlEnt.length || wlEx.length ? `<div style="background:#fff8e6;border:1px solid #f0dfae;border-radius:10px;padding:12px 16px;margin-bottom:16px"><b>ברשימת המעקב שלך:</b><br>${wlEnt.length ? 'נכנסו: ' + wlEnt.join(', ') + '<br>' : ''}${wlEx.length ? 'יצאו: ' + wlEx.join(', ') : ''}</div>` : ''}
<p><b style="color:#15803d">נכנסו היום (${entries.length}):</b> <span dir="ltr">${list(entries)}</span></p>
<p><b style="color:#b91c1c">יצאו (${exits.length}):</b> <span dir="ltr">${list(exits)}</span></p>
<h3 style="margin:20px 0 8px">עשרת המובילות</h3>
<table dir="ltr" style="width:100%;border-collapse:collapse;font-size:13px">
<tr style="background:#f0f4fa"><th style="padding:6px;text-align:left">Ticker</th><th style="padding:6px">Score</th><th style="padding:6px">RS</th><th style="padding:6px">Price</th></tr>
${top.map(r => `<tr><td style="padding:6px;border-top:1px solid #edf1f7"><b>${r.t}</b></td><td style="padding:6px;border-top:1px solid #edf1f7;text-align:center">${r.sc}</td><td style="padding:6px;border-top:1px solid #edf1f7;text-align:center">${r.rs}</td><td style="padding:6px;border-top:1px solid #edf1f7;text-align:center">$${r.c.toFixed(2)}</td></tr>`).join('')}
</table>
<p style="color:#8b99b0;font-size:11px;margin-top:20px">Minervini SEPA classic · davidtheking28-oss.github.io</p>
</div></body></html>`;
    const er = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [u.email], subject: `SEPA ${scanDate}: ${entries.length} נכנסו · ${exits.length} יצאו`, html }),
    });
    if (er.ok) sent++;
  }
  return { sent };
}

Deno.serve(async (req: Request) => {
  const secretRes = await sb(`/rest/v1/app_secrets?key=eq.cron_secret&select=value`);
  const secretRows = secretRes.ok ? await secretRes.json() : [];
  const cronSecret = secretRows[0]?.value || '';
  if (!cronSecret || req.headers.get('x-cron-key') !== cronSecret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const universe = await fetchUniverse();
    const rsMap = computeRS(universe);
    const results = applyClassicSEPA(universe, rsMap);

    // Denominator counts only names with a full MA set — must stay identical to the
    // client-side breadth in מסנן-מניות.html, otherwise the history sparkline drawn
    // from these rows disagrees with the live label above it.
    let up = 0, rated = 0;
    for (const r of universe) {
      const d = r.d, c = d[C.close] as number, s50 = d[C.SMA50] as number, s150 = d[C.SMA150] as number, s200 = d[C.SMA200] as number;
      if (!(c && s50 && s150 && s200)) continue;
      rated++;
      if (c > s150 && c > s200 && s150 > s200 && s50 > s150 && c > s50) up++;
    }
    const breadth = rated ? Math.round(up / rated * 100) : 0;

    // Cron fires at 22:10 UTC, which is already past midnight in Israel (UTC+2/+3) —
    // using the UTC date here would label the scan with yesterday's date from the
    // Israeli user's perspective. Use the Israel calendar date instead.
    const scanDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    const prevRes = await sb(`/rest/v1/screener_daily?scan_date=lt.${scanDate}&order=scan_date.desc&limit=21&select=scan_date,tickers,summary`);
    const prevRows: { scan_date: string; tickers: { t: string; c: number }[]; summary: { entries?: string[] } | null }[] =
      prevRes.ok ? await prevRes.json() : [];
    const prevSet = new Set<string>((prevRows[0]?.tickers || []).map(r => r.t));
    const todaySet = new Set(results.map(r => r.t));
    const entries = prevRows.length ? results.map(r => r.t).filter(t => !prevSet.has(t)) : [];
    const exits = prevRows.length ? [...prevSet].filter(t => !todaySet.has(t)) : [];

    const priceNow = new Map<string, number>();
    for (const r of universe) {
      const t = r.d[C.name] as string, c = r.d[C.close] as number;
      if (t && c) priceNow.set(t, c);
    }
    const fwd = (idx: number) => {
      const row = prevRows[idx];
      if (!row) return null;
      const entryTickers = row.summary?.entries || [];
      const priceThen = new Map((row.tickers || []).map(x => [x.t, x.c]));
      const rets: number[] = [];
      for (const t of entryTickers) {
        const p0 = priceThen.get(t), p1 = priceNow.get(t);
        if (p0 && p1) rets.push((p1 / p0 - 1) * 100);
      }
      if (!rets.length) return null;
      return { n: rets.length, avg: +(rets.reduce((a, b) => a + b, 0) / rets.length).toFixed(1) };
    };
    const perf: Record<string, { n: number; avg: number }> = {};
    const p5 = fwd(4), p10 = fwd(9), p20 = fwd(19);
    if (p5) perf.d5 = p5;
    if (p10) perf.d10 = p10;
    if (p20) perf.d20 = p20;

    const put = await sb('/rest/v1/screener_daily', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        scan_date: scanDate,
        tickers: results,
        summary: { entries, exits, count: results.length, universe: universe.length, breadth, ...(Object.keys(perf).length ? { perf } : {}) },
      }),
    });
    if (!put.ok) throw new Error('save failed ' + put.status + ' ' + await put.text());

    const mail = await sendEmails(scanDate, entries, exits, results, breadth);
    const telegram = await sendTelegramAlert(scanDate, entries, exits).catch(e => ({ sent: 0, reason: String(e) }));

    return new Response(JSON.stringify({ ok: true, scanDate, count: results.length, entries: entries.length, exits: exits.length, breadth, mail, telegram }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

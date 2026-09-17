import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { COLUMNS, C, FILTERS, Row, computeRS, applyClassicSEPA } from './scoring.ts';

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
  let sent = 0;
  for (const u of users) {
    const wl = new Set(wlRows.filter(w => w.user_id === u.id).map(w => w.ticker));
    const wlEnt = entries.filter(t => wl.has(t)), wlEx = exits.filter(t => wl.has(t));
    const mark = (t: string) => wl.has(t) ? `<b style="color:#b45309">★${t}</b>` : t;
    const list = (a: string[]) => a.map(mark).join(', ') || '—';
    const html = `<!DOCTYPE html><html dir="rtl" lang="he"><body style="font-family:Arial,sans-serif;background:#f5f7fb;padding:24px;color:#1a2433">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #e3e9f2">
<h2 style="margin:0 0 4px">SEPA Screener — סריקת לילה ${scanDate}</h2>
<p style="color:#5b6b85;margin:0 0 18px">רוחב שוק: ${breadth}% מהמניות במגמת עלייה · ${results.length} מניות עוברות את הסינון</p>
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

    return new Response(JSON.stringify({ ok: true, scanDate, count: results.length, entries: entries.length, exits: exits.length, breadth, mail }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

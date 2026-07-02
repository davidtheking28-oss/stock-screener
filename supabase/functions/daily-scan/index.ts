import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'SEPA Screener <onboarding@resend.dev>';

const COLUMNS = [
  "name","description","close","SMA50","SMA150","SMA200",
  "price_52_week_high","price_52_week_low","Perf.Y",
  "earnings_per_share_diluted_yoy_growth_fq",
  "total_revenue_yoy_growth_fq","return_on_equity_fq",
  "net_margin","sector","market_cap_basic",
  "average_volume_10d_calc","Perf.3M","Perf.6M",
];
const C: Record<string, number> = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));

const FILTERS = { rsMin: 70, fromHigh: 0.25, fromLow: 0.25, priceMin: 10, mcMin: 2e9, liqMin: 20e6, epsMin: 25, revMin: 20, roeMin: 17 };

type Row = { s: string; d: (number | string | null)[] };

async function sb(path: string, init: RequestInit = {}) {
  return fetch(`${SB_URL}${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
}

async function fetchUniverse(): Promise<Row[]> {
  const body = {
    columns: COLUMNS,
    filter: [
      { left: "type", operation: "equal", right: "stock" },
      { left: "is_primary", operation: "equal", right: true },
      { left: "close", operation: "egreater", right: 2 },
      { left: "market_cap_basic", operation: "egreater", right: 50000000 },
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

function computeRS(universe: Row[]): Record<string, number> {
  const raw = (d: Row['d']) => {
    const p3 = d[C['Perf.3M']] as number | null, p6 = d[C['Perf.6M']] as number | null, py = d[C['Perf.Y']] as number | null;
    if (p3 == null && p6 == null && py == null) return null;
    return 0.4 * (p3 ?? 0) + 0.3 * (p6 ?? 0) + 0.3 * (py ?? 0);
  };
  const valid = universe.map(r => ({ s: r.s, p: raw(r.d) })).filter(r => r.p != null).sort((a, b) => (a.p as number) - (b.p as number));
  const n = valid.length; const map: Record<string, number> = {};
  valid.forEach((row, i) => { map[row.s] = Math.max(1, Math.min(99, Math.round((i / (n - 1)) * 98) + 1)); });
  return map;
}

function applyClassicSEPA(universe: Row[], rsMap: Record<string, number>) {
  const out: { t: string; sym: string; rs: number; sc: number; c: number; sec: string }[] = [];
  for (const r of universe) {
    const d = r.d;
    const close = d[C.close] as number, s50 = d[C.SMA50] as number, s150 = d[C.SMA150] as number, s200 = d[C.SMA200] as number;
    const hi = d[C.price_52_week_high] as number, lo = d[C.price_52_week_low] as number, mc = d[C.market_cap_basic] as number;
    if ([close, s50, s150, s200, hi, lo].some(v => v == null)) continue;
    if (close < FILTERS.priceMin || mc < FILTERS.mcMin) continue;
    const avgVol = d[C.average_volume_10d_calc] as number | null;
    if (avgVol == null || close * avgVol < FILTERS.liqMin) continue;
    const rs = rsMap[r.s] ?? 0;
    const perf6 = d[C['Perf.6M']] as number | null;
    const eps = d[C.earnings_per_share_diluted_yoy_growth_fq] as number | null;
    const rev = d[C.total_revenue_yoy_growth_fq] as number | null;
    const roe = d[C.return_on_equity_fq] as number | null;
    const nm = d[C.net_margin] as number | null;
    const pass = close > s150 && close > s200 && s150 > s200 && s50 > s150 && s50 > s200
      && (perf6 != null && perf6 > 0)
      && close > s50 && close >= lo * (1 + FILTERS.fromLow) && close >= hi * (1 - FILTERS.fromHigh)
      && rs >= FILTERS.rsMin
      && eps != null && eps >= FILTERS.epsMin && rev != null && rev >= FILTERS.revMin
      && roe != null && roe >= FILTERS.roeMin && nm != null && nm > 0;
    if (!pass) continue;
    const fromHighPct = (close / hi - 1) * 100;
    const rsS = Math.min(rs, 99) / 99 * 40;
    const epsS = Math.min(Math.max(eps, 0), 300) / 300 * 25;
    const revS = Math.min(Math.max(rev, 0), 200) / 200 * 20;
    const hiS = Math.max(0, Math.min(1, 1 - Math.abs(fromHighPct) / 25)) * 15;
    out.push({
      t: d[C.name] as string, sym: r.s, rs,
      sc: Math.round(rsS + epsS + revS + hiS),
      c: close, sec: (d[C.sector] as string) || '—',
    });
  }
  return out.sort((a, b) => b.sc - a.sc);
}

async function sendEmails(scanDate: string, entries: string[], exits: string[], results: ReturnType<typeof applyClassicSEPA>, breadth: number) {
  if (!RESEND_KEY) return { sent: 0, reason: 'no RESEND_API_KEY' };
  const usersRes = await sb('/auth/v1/admin/users?per_page=200');
  if (!usersRes.ok) return { sent: 0, reason: 'admin users ' + usersRes.status };
  const users: { id: string; email: string }[] = ((await usersRes.json()).users || []).filter((u: { email?: string }) => u.email);
  const wlRes = await sb('/rest/v1/screener_watchlist?select=user_id,ticker');
  const wlRows: { user_id: string; ticker: string }[] = wlRes.ok ? await wlRes.json() : [];
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

    const up = universe.filter(r => {
      const d = r.d, c = d[C.close] as number, s50 = d[C.SMA50] as number, s150 = d[C.SMA150] as number, s200 = d[C.SMA200] as number;
      return c && s50 && s150 && s200 && c > s150 && c > s200 && s150 > s200 && s50 > s150 && c > s50;
    }).length;
    const breadth = Math.round(up / universe.length * 100);

    const scanDate = new Date().toISOString().slice(0, 10);
    const prevRes = await sb(`/rest/v1/screener_daily?scan_date=lt.${scanDate}&order=scan_date.desc&limit=1&select=scan_date,tickers`);
    const prevRows = prevRes.ok ? await prevRes.json() : [];
    const prevSet = new Set<string>((prevRows[0]?.tickers || []).map((r: { t: string }) => r.t));
    const todaySet = new Set(results.map(r => r.t));
    const entries = prevRows.length ? results.map(r => r.t).filter(t => !prevSet.has(t)) : [];
    const exits = prevRows.length ? [...prevSet].filter(t => !todaySet.has(t)) : [];

    const put = await sb('/rest/v1/screener_daily', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        scan_date: scanDate,
        tickers: results,
        summary: { entries, exits, count: results.length, universe: universe.length, breadth },
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

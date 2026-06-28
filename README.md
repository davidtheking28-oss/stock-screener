# SEPA Stock Screener

מסנן מניות בשיטת Minervini SEPA — סורק 8,000 מניות אמריקאיות ומסנן לפי Trend Template + ניתוח פונדמנטלי.

**Live:** https://davidtheking28-oss.github.io/stock-screener/

## תכונות

- סריקה בזמן אמת של 8,000 מניות מ-TradingView
- 8 תנאי Trend Template (MA50 > MA150 > MA200 וכו')
- RS Rating — דירוג יחסי לפי ביצוע 12 חודשים
- ציון SEPA 0–100 לכל מניה (RS + EPS + הכנסות + קרבה לשיא)
- 3 פריסטים: קלאסי / אגרסיבי / שמרני
- גלריית גרפים עם TradingView Widgets
- Watchlist מסונכרן בענן (דורש כניסה עם magic link)
- ייצוא CSV
- ניווט מקלדת: j/k לזוז, Enter לגרף, Esc לסגור

## טכנולוגיות

- Static HTML + Vanilla JS (ללא framework)
- Supabase — Auth (magic link) + DB (watchlist, prefs)
- Supabase Edge Function — proxy לTradingView עם caching של 5 דקות
- GitHub Pages — hosting
- TradingView Scanner API + Widgets

## GitHub Secrets נדרשים

| Secret | תיאור |
|--------|-------|
| `SUPABASE_ANON` | Supabase anon/public key |

## פיתוח מקומי

פתח את `מסנן-מניות.html` ישירות בדפדפן. הסריקה תפעל ישירות מול TradingView (ללא Edge Function) ורשימת המעקב תישמר ב-localStorage.

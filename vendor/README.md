# Bundled runtime libraries

Copied from the exact CDN versions previously used by this page. No library upgrade.
Supabase SRI remains the existing sha384 value in the HTML. License notices are retained.

| File | SHA-256 |
| --- | --- |
| supabase-2.117.2.min.js | 2eebfe06b1b5309985dc1526e8981ea3a18b71beeef83e7f38e04c303e142d6d |
| lightweight-charts-4.2.0.js | 46fc69534ec098f095bbcd1d9a26d693d39a8b9eeff7343536765b3dd28c2bdf |

Sources:
- https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.min.js
- https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js

A single cold local Chromium comparison measured DOM ready at 3331 ms with remote dependencies versus 215 ms with local dependencies. Both library globals were verified. This compares remote CDN requests against a local test server; it is not a production latency estimate. Production performance must be measured after deployment.
Regression suite: 411/411 checks passed, including both bundled runtime globals.

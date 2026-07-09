---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Support EmDash 0.28.

Migrate from emdash 0.6 to 0.28.1. The plugin now builds its native
`ResolvedPlugin` via `definePlugin` with single-argument `RouteContext`
handlers (emdash's native route shape) instead of `adaptSandboxEntry`, whose
0.28 form flattens the request and would break the Stripe webhook's raw-body
signature check. Capability names are updated to the current vocabulary
(`network:request`, `content:read`, `content:write`, `media:read`,
`users:read`), and the emdash peer range is now `>=0.28.0 <0.29.0`.

The bundled emdash patch is re-authored for 0.28.1: plugin route handlers may
still return a raw `Response` (cookies, redirects, webhook 200s), and the raw
request body is preserved so `ctx.request.text()` works for Stripe webhook
signature verification.

The starter adds a Cloudflare Worker entry (`src/worker.ts`) plus a Cron
Trigger so plugin cron — abandoned-cart recovery, subscription dunning, and
stock-lock sweeps — runs on Workers (emdash 0.19+ drives cron from a
`scheduled()` handler, not request side effects).

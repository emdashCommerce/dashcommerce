---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Support EmDash 1.6.0. Ship `patches/emdash@1.6.0.patch` (same raw Response passthrough and request body clone fix as 1.5.0, retargeted at 1.6.0's hashed dist files `routes-BScyES_G.mjs` and `http-route-dispatch-Y8bwyixm.mjs`). Widen the EmDash peer range to `>=0.37.0 <0.38.0 || >=1.1.0 <1.7.0` so create-emdash 1.6 installs pass peer checks. Cap below 1.7 so the next untested EmDash minor is still rejected. Point the starter at `emdash` / `@emdash-cms/cloudflare` ^1.6.0 and refresh its migrations snapshot through `098_user_last_login`.

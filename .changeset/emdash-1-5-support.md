---
"@dashcommerce/core": patch
"@dashcommerce/starter": patch
---

Support EmDash 1.5.0. Ship `patches/emdash@1.5.0.patch` (same raw Response passthrough and request body clone fix as 1.4.0, retargeted at 1.5.0's hashed dist files `routes-QcHRiebw.mjs` and `http-route-dispatch-BsjkWBZF.mjs`). Widen the EmDash peer range to `>=0.37.0 <0.38.0 || >=1.1.0 <1.6.0` so create-emdash 1.5 installs pass peer checks. Cap below 1.6 so the next untested EmDash minor is still rejected. Point the starter at `emdash` / `@emdash-cms/cloudflare` ^1.5.0, refresh its migrations snapshot, and type PortableText `value` for 1.5.0's stricter `emdash/ui` props.

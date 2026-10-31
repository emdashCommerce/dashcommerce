---
"@dashcommerce/core": patch
---

Support EmDash 1.4.0. Ship `patches/emdash@1.4.0.patch` (same raw Response passthrough and request body clone fix as 1.3.1, retargeted at 1.4.0's hashed dist files). Widen the EmDash peer range to `>=0.37.0 <0.38.0 || >=1.1.0 <1.5.0` so create-emdash 1.4 installs pass peer checks. Cap below 1.5 so the next untested EmDash minor is still rejected.

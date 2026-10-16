---
"@dashcommerce/core": patch
---

Support EmDash 1.3.0. Ship `patches/emdash@1.3.0.patch` (same raw Response passthrough and request body clone fix as 1.2.0, retargeted at the 1.3.0 hashed dist files). Cap the EmDash peer range at `>=0.37.0 <0.38.0 || >=1.1.0 <1.4.0` so untested EmDash releases without a matching patch are rejected instead of silently dropping Set-Cookie and breaking webhooks.

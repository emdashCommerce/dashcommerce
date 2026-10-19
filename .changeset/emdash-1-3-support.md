---
"@dashcommerce/core": patch
---

Support EmDash 1.3.0 and 1.3.1. Ship `patches/emdash@1.3.0.patch` and `patches/emdash@1.3.1.patch` (same raw Response passthrough and request body clone fix as 1.2.0, retargeted at each release's hashed dist files). Cap the EmDash peer range at `>=0.37.0 <0.38.0 || >=1.1.0 <1.4.0` so untested EmDash releases are rejected instead of silently dropping Set-Cookie and breaking webhooks.

Fix EmDash version detection so the compatibility check actually runs. `dashcommerce()` now detects the installed EmDash version and passes it to the plugin. If that version is in range but has no shipped patch (for example 1.3.2), DashCommerce prints a loud warning in the dev/build terminal and again at plugin init. Versions outside the supported range now fail at plugin init, as the check intended.

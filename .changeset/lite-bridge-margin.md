---
"@dashcommerce/lite": patch
---

Lite keeps 2 calls of headroom under the sandbox subrequest cap: every invocation now makes at most 8 bridge calls (the cap is 10). Paid orders take their stock in cron tasks on the next tick, larger remainders are split into slice tasks that run in the same tick, and the storefront kit retries `CHECKOUT_CONTINUE` up to 8 times.

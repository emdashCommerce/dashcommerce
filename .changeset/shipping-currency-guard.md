---
"@dashcommerce/core": patch
---

Only offer shipping methods priced in the cart's currency. A flat-rate or local-pickup method in another currency (or a free-shipping threshold set in another currency) used to be offered, and choosing it failed with a 500 (`CurrencyMismatchError`). It is now left out, like weight-based methods already were.

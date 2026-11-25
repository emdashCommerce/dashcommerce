---
"@dashcommerce/core": patch
---

Refuse `stripe_tax` checkout with a non-Stripe provider instead of charging the pre-tax total.

Stripe Tax is calculated by Stripe at checkout, so core returns zero tax for `taxMode: "stripe_tax"`. A provider that ignores `automatic_tax` would silently undercharge. `checkout/create-session` now returns `409 stripe_tax_requires_stripe` and asks the merchant to switch to flat/table tax or to Stripe.

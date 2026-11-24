---
"@dashcommerce/flutterwave": minor
---

New package: a Flutterwave payment provider for DashCommerce, built on core's PaymentProvider interface.

- Card, M-Pesa and mobile money through Flutterwave's hosted checkout. Currencies: NGN, USD, GBP, EUR, KES, GHS, ZAR, UGX, TZS, RWF, XOF, XAF, ZMW, MWK and EGP.
- Amounts are converted at the boundary: core keeps minor units, Flutterwave's v3 API charges major units.
- Orders are created only from a signed `charge.completed`, confirmed against Flutterwave before the order is written. `verif-hash` is checked in constant time against the secret hash saved in Settings → Webhooks.
- Repeat and overlapping webhook deliveries run once: each charge and refund event carries an event id core can deduplicate on.
- Refunds by transaction id or `tx_ref`, guarded against duplicates on retry, with Flutterwave's refund webhook moving each refund to succeeded or failed.
- "Test Flutterwave connection" in Settings checks the saved key in test or live mode with a read-only balances call.

Needs `@dashcommerce/core` 0.4.0 or later. Register it with `import "@dashcommerce/flutterwave"` in a server module, add `api.flutterwave.com` to `allowedHosts`, and point Flutterwave's webhook at `…/checkout/webhook?provider=flutterwave`; see the package README.

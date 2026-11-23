---
"@dashcommerce/paystack": minor
---

New package: a Paystack payment provider for DashCommerce, built on core's PaymentProvider interface.

- Card and M-Pesa payments through Paystack's hosted page, or its Popup over your checkout. Currencies: KES, NGN, GHS, ZAR and USD.
- Orders are created only from a signed `charge.success`, confirmed against Paystack before the order is written. `Paystack-Signature` (with a `whsec_` secret, 300-second replay window) and `x-paystack-signature` (with the `sk_` key) are both verified.
- Repeat and overlapping webhook deliveries run once: each `charge.success` and `refund.*` event carries an event id core can deduplicate on.
- Refunds by transaction reference, guarded against duplicates on retry, with `refund.*` webhooks moving each refund to succeeded or failed.
- "Test Paystack connection" in Settings checks the saved key in test or live mode.

Needs `@dashcommerce/core` 0.4.0 or later. Register it with `import "@dashcommerce/paystack"` in a server module, add `api.paystack.co` to `allowedHosts`, and point Paystack's webhook at `…/checkout/webhook?provider=paystack`; see the package README.

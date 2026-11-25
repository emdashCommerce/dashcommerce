---
"@dashcommerce/flutterwave": minor
---

New package: a Flutterwave payment provider for DashCommerce, built on core's PaymentProvider interface.

- Hosted checkout and on-page Flutterwave Inline (card, M-Pesa, mobile money) in NGN, USD, GBP, EUR, KES, GHS, ZAR, UGX, TZS, RWF, XOF, XAF, ZMW, MWK and EGP.
- Amounts convert at the boundary: core keeps minor units, Flutterwave's v3 API charges major units.
- Orders only from a signed `charge.completed`, confirmed with a live verify. `verif-hash` is checked in constant time against the secret hash; repeat and overlapping deliveries are deduplicated.
- Refunds by transaction id or `tx_ref`, guarded against duplicates on retry, with Flutterwave's refund webhook moving each refund to succeeded or failed.
- Split payments: core's exact per-vendor allocations map to `subaccounts` with `flat_subaccount`, for hosted and Inline. The subaccount default may be percentage or flat; the transaction override keeps the shares exact.
- In-admin vendor onboarding: list banks or mobile-money channels, verify the account name, create the collection subaccount, and store the masked result. Re-adding the same bank account returns the existing subaccount instead of failing.
- Cart discounts: `capabilities.coupons` is true; the discount is applied to the amount Flutterwave charges.
- Split reconciliation: parses `meta.split_settlement_info` and `app_fee` into core's `splitSettlement`, so the order records what each subaccount earned.
- "Test Flutterwave connection" checks the saved key in test or live mode with a read-only balances call.

Needs core 0.4.0 or later with the provider seams (public key, split allocations, payout onboarding, split settlement). Register with `import "@dashcommerce/flutterwave"`, add `api.flutterwave.com` to `allowedHosts`, and point the webhook at `…/checkout/webhook?provider=flutterwave`.

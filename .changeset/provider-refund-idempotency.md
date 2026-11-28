---
"@dashcommerce/core": minor
---

Harden refund idempotency with a local ledger.

- `admin/orders/refund` accepts a `refundRequestId`. The admin UI locks the original details and reuses that ID while the outcome is unknown or pending.
- `refundOrder` returns the recorded refund to the same order for a repeated request ID, including when the original refund exhausted the balance.
- The admin refund panel now says "the payment provider" rather than "Stripe", and shows a failed provider refund as an error instead of a success.

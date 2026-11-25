---
"@dashcommerce/core": minor
---

Harden refund idempotency with a local ledger.

- `admin/orders/refund` accepts a `refundRequestId`. The admin UI generates one per attempt and reuses it if the request fails before the provider answers, so a retry uses the same provider idempotency key.
- `refundOrder` returns the recorded refund for a repeated request id instead of calling the provider again. This covers providers whose refund key is a comment tag and whose refund-list endpoint may be unavailable.
- The admin refund panel now says "the payment provider" rather than "Stripe", and shows a failed provider refund as an error instead of a success.

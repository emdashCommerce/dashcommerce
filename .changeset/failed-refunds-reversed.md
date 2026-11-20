---
"@dashcommerce/core": minor
---

A refund that fails at the payment provider no longer counts against its order.

- When a provider reports a pending refund as failed (`refund.updated`), core takes its amount back off the order's refunded total, works out the payment and order status again, and takes back any stock the refund put back. With no refund left counting, the order returns to the status it had before its first refund (refunds now record it as `orderStatusBefore`). Stock that has been sold again is not taken back; that is logged.
- A refund the provider fails straight away is recorded as failed and changes nothing on the order: no totals, no restock, no refund email.
- The failed refund stays on the order, marked failed, and is logged as an error.
- New inventory ledger reason `refund_failed`.

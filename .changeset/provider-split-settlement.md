---
"@dashcommerce/core": minor
---

Record provider-reported split settlements on the order.

- `NormalizedPaymentEvent` `charge.succeeded` gains `splitSettlement`: per-account minor amounts, the platform remainder and the provider fee, when the provider reports them.
- `Order.providerSplits` stores it with the account reference mapped to a vendor when core can resolve it, for reconciliation. It never changes the vendor shares core computed.
- The webhook records it after the order is written. A failure is logged and does not make the webhook retry, because the order is already complete.
- The admin order detail shows a "Split settlement" card when the order has one.

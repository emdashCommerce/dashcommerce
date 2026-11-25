---
"@dashcommerce/core": minor
---

Make split refunds explicit.

- `PaymentProviderCapabilities.splitRefunds` lets a provider declare that its API cannot refund a split charge. Missing means yes, preserving Stripe Connect behaviour.
- `refundOrder` refuses a split order before calling a provider that declares `splitRefunds: false`, with a message pointing to the provider's dashboard.
- The order detail's **Split settlement** card warns that a refund comes from the platform balance and that vendor shares are not recovered automatically.

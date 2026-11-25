---
"@dashcommerce/core": minor
---

Add a provider-neutral subscription seam.

- `PaymentProvider` gains optional `getSubscription`, `cancelSubscription` and `resumeSubscription`. Stripe keeps its existing Billing path; providers that manage billing themselves can use these.
- `charge.succeeded` and `PaymentStatusResult` can carry `ProviderSubscriptionInfo`, so a provider can identify the subscription/plan behind a charge.
- New `subscriptions/provider.ts` stores a provider-managed subscription and its invoices in the existing collections. The first charge creates an order and a local subscription; later charges are recorded as invoices and extend the period, not as new orders.
- `subscriptions/lifecycle.ts` dispatches cancel/resume to a provider-managed subscription. Pause and in-place plan changes are refused for providers that do not support them.
- Stripe's `stripeSubscriptionId`/`stripeInvoiceId` fields keep their names for compatibility; they now hold the provider's subscription/plan and invoice id.

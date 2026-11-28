---
"@dashcommerce/core": minor
---

Add a provider-neutral subscription seam.

- `PaymentProvider` gains optional `getSubscription`, `cancelSubscription` and `resumeSubscription`. Stripe keeps its existing Billing path; providers that manage billing themselves can use these.
- `charge.succeeded` and `PaymentStatusResult` can carry `ProviderSubscriptionInfo`, so a provider can identify the subscription/plan behind a charge.
- A normalised `subscription.updated` event lets a provider report a cancellation or status change outside a charge; core updates the local row.
- New `subscriptions/provider.ts` stores a provider-managed subscription and its invoices in the existing collections. The provider id is part of the unique storage key for both subscriptions and invoices (`${providerId}:${id}`), so two providers cannot collide on a numeric plan or transaction id. The first charge creates an order and a local subscription; later charges are recorded as invoices and extend the period, not as new orders.
- A charge webhook can retry an incomplete subscription link or billing period update. A paid invoice stores its target period so a retry completes the same renewal.
- `subscriptions/lifecycle.ts` dispatches cancel/resume to a provider-managed subscription. Pause and in-place plan changes are refused for providers that do not support them. The admin and customer portal hide pause and the Stripe billing portal for those subscriptions.
- Stripe's `stripeSubscriptionId`/`stripeInvoiceId` fields keep their names for compatibility; they now hold the provider's subscription/plan and invoice id.

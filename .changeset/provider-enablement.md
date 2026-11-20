---
"@dashcommerce/core": minor
---

Make non-Stripe payment providers usable on a live site.

- `dashcommerce({ allowedHosts })` adds a provider's API hosts to Stripe's. Without it the hosts are unchanged.
- The settings API saves `<id>SecretKey` and `<id>WebhookSecret` for registered providers, validated against the prefixes a provider declares in `credentialFields` and masked like Stripe's. `GET admin/settings` lists registered providers under `_providers`. Settings shows a Payment provider card with a picker when a provider other than Stripe is registered.
- A provider can declare `checkConnection`, a read-only check of its saved keys. Settings then shows a "Test connection" button for it, like Stripe's.
- `verifyWebhook` receives every request header and the provider's saved credentials (for headers signed with the API key rather than the webhook secret), and a provider can declare `webhookHeaders` for routing. `stripe-signature` stays reserved for Stripe.
- A new normalised event, `refund.updated`, moves a provider's pending refund to `succeeded` or `failed`.
- A webhook retry is now processed when the first delivery failed only because the payment could not be confirmed with the provider (`getPaymentStatus`, or Stripe's PaymentIntent retrieve on `checkout.session.completed`). Before, it was answered as a duplicate and the order was never created. Other handler failures still keep the retry deduplicated.

---
"@dashcommerce/core": patch
---

The log line for a skipped duplicate webhook now reads "Webhook deduped" and names the provider, instead of "Stripe webhook deduped" for every provider. Its fields are now `providerId`, `eventId` (was `stripeEventId`) and `type`.

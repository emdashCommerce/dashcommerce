---
"@dashcommerce/core": patch
---

Stop public review and subscription routes from returning stored records. `GET /reviews/list` and `GET /reviews/item` now return an allowlisted shape (id, rating, title, body, display name, createdAt, verifiedPurchase) so customer email, customerId and moderation metadata never reach the storefront. `GET /subscriptions/state` returns only the portal island fields (status, amount, interval, period end, cancel-at-period-end) and no longer includes stripeSubscriptionId or customerId. Cancel/pause/resume still run; they echo Stripe status, not Stripe ids.

---
"@dashcommerce/core": patch
---

Stop `GET /orders/by-draft` from returning the full stored order (#68). The route is public and its draft id travels in the thank-you URL, so the `ready` response now carries only what the thank-you page renders: order id, number, status, currency, total, a masked customer email, and each item's id, name, quantity and total. Addresses, Stripe ids, IP address, user agent, coupon codes, notes, metadata and vendor data are no longer exposed. The receipt line on the thank-you page now shows the masked email (`j***@example.com`).

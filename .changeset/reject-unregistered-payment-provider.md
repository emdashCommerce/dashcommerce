---
"@dashcommerce/core": patch
---

Settings refuse a `paymentProvider` that isn't registered on the server, with a 400 that names the registered providers. Before, a typo or a provider whose package wasn't imported saved fine and then failed at checkout.

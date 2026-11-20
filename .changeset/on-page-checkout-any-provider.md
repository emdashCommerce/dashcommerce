---
"@dashcommerce/core": minor
"@dashcommerce/starter": patch
---

On-page ("embedded") checkout for any provider that offers it, not only Stripe.

- Providers declare `checkoutStyles` (`hosted`, `on_page`); `initCheckout` receives `checkoutStyle` and may return an `on_page` result with `client` data for the provider's browser client. Stripe declares both, and its Elements flow is unchanged.
- With `checkoutMode` embedded, `create-session` returns `{ kind: "on_page", client, returnUrl }` for a provider that supports it, and a 409 naming the provider for one that doesn't. Redirect results gain `kind: "redirect"`.
- `HostedCheckoutForm` opens the provider's client from `window.DashCommerceCheckoutClients` (`OnPageCheckoutClient`). Its callbacks only move the customer; the order is still created only from the signed webhook.
- Settings offers "How customers pay" (hosted or on your page) for a provider that supports both.

---
"@dashcommerce/core": minor
"@dashcommerce/starter": patch
---

Checkout follows the active payment provider instead of assuming Stripe.

- New provider flag `collectsCustomerDetails` (Stripe sets it). For providers whose page collects neither email nor address, `create-session` answers 409 `customer_details_required` until the cart has them, and `HostedCheckoutForm` asks for email, name, phone and address (country only for digital carts), saved through `cart/contact`.
- `HostedCheckoutForm` names the provider on its button and shows readable errors when a route crashes (EmDash wraps those as `{ error: { code, message } }`), which used to show `[object Object]` for Stripe too.
- `config-check` reports `paymentProvider`.
- Starter: checks the active provider's keys, and the cart and announcement copy no longer name Stripe.

Stripe stores see no change.

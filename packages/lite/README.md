# DashCommerce (sandboxed)

The registry build of DashCommerce for EmDash, listed as `dashcommerce-lite`.
Simple products from the `products` collection, a token-based cart, Stripe
hosted Checkout, a signed Stripe webhook, a stock ledger, refunds from
Stripe, flat tax and shipping or Stripe Tax, and Block Kit pages for
orders, stock and settings.

This package lives at `packages/lite` (`@dashcommerce/lite`, private). The
full native plugin is `@dashcommerce/core`.

Lite uses its own plugin id, `dashcommerce-lite` (routes under
`/_emdash/api/plugins/dashcommerce-lite/`), so it does not clash with the
native plugin's `dashcommerce`. Install one or the other, not both: each
runs its own cart, checkout, orders and Stripe webhook. See `CHANGELOG.md`.

See `DESIGN.md` for the architecture, routes and limits, and
`PUBLISHING.md` for releases.

## Setup

1. Install DashCommerce Lite (`dashcommerce-lite`) from the plugin
   registry and approve its access: read content, and network requests to
   `api.stripe.com`. Requires EmDash 1.3 or later. Do not also install the
   native `@dashcommerce/core` on the same site.
2. Set `EMDASH_ENCRYPTION_KEY` on the site so the Stripe keys can be stored
   encrypted.
3. Open DashCommerce > Settings, add the Stripe secret key, and add a Stripe
   webhook endpoint for the URL and events shown there. Then add the
   signing secret.
4. Add the storefront kit to your theme: copy `storefront/dashcommerce.js`
   and `storefront/dashcommerce.d.ts` to `src/lib/`, and the components in
   `storefront/astro/` to `src/components/`.

```astro
---
import AddToCart from "../components/AddToCart.astro";
---
<AddToCart productId={product.id} />
```

Use `<Cart />` on a cart page, `<CartCount />` in the header and
`<CheckoutSuccess />` on `/checkout/success`. The kit stores the cart token
in localStorage under `dashcommerce-cart`.

The DashCommerce starter (`packages/starter`) has the kit wired in behind
`DASHCOMMERCE_EDITION=sandboxed`. See its README.

## Development

```sh
bun run validate      # manifest
bun run typecheck
bun run test          # unit tests
bun run test:sandbox  # runs the plugin in workerd
bun run bundle && bun run size
```

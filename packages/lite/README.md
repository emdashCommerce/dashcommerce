# DashCommerce Lite

Sandboxed commerce plugin for EmDash: simple products from the `products`
collection, a token-based cart, Stripe hosted Checkout, and a signed Stripe
webhook. Admin pages for orders and settings use Block Kit.

Status: early. See `DESIGN.md` for the architecture, routes and the
storefront integration.

## Setup

1. Install the plugin and approve its access: read content, and network
   requests to `api.stripe.com`.
2. Set `EMDASH_ENCRYPTION_KEY` on the site so the Stripe keys can be stored
   encrypted.
3. Open DashCommerce Lite > Settings, add the Stripe secret key, and add a
   Stripe webhook endpoint for the URL shown there.

## Development

```sh
bun run validate      # manifest
bun run typecheck
bun run test          # unit tests
bun run test:sandbox  # runs the plugin in workerd
bun run bundle && bun run size
```

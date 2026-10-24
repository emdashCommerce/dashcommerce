DashCommerce Lite turns the entries in your `products` collection into a
shop. Shoppers add items to a cart and pay on Stripe's hosted Checkout
page. You manage orders, stock and settings in the EmDash admin. It runs
as a sandboxed plugin, so there is nothing to install from npm.

## What it does

- Prices, SKU and stock settings come from each product entry.
- A cart that needs no shopper account.
- Stripe hosted Checkout, including methods that confirm later, such as
  SEPA Direct Debit.
- A signed Stripe webhook: an order is marked paid only when Stripe says
  so, and repeated events are ignored.
- Stock is taken when payment is confirmed and put back when a paid order
  is cancelled or fully refunded.
- Refunds made in the Stripe Dashboard show up on the order.
- Flat tax and shipping, or Stripe Tax.
- Admin pages for orders (search, cancel, CSV export), stock and
  settings, plus a Recent orders widget.

## Access it asks for

Read content (product prices and stock), network requests to
`api.stripe.com` only, and its own storage for orders, carts, stock and
Stripe events.

## Before you install

- **Cloudflare Workers Paid is required.** EmDash runs sandboxed plugins
  in Worker Loaders, which are only on the paid plan.
- Requires EmDash 1.3 or later.
- **Do not install it alongside `@dashcommerce/core`**, the full
  DashCommerce plugin on npm. Each runs its own cart, checkout, orders and
  Stripe webhook. Pick one.
- Simple products only. Variable products, subscriptions and order emails
  are in `@dashcommerce/core`.
- Your theme needs the small storefront kit. See Installation.

## Links

- Source: https://github.com/emdashCommerce/dashcommerce/tree/main/packages/lite
- Docs: https://github.com/emdashCommerce/dashcommerce/blob/main/packages/lite/README.md

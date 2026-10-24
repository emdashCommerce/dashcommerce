# DashCommerce Lite changelog

Lite is published to the EmDash plugin registry only (it is `private` on
npm), so it keeps its own changelog here.

## 0.2.0 (unreleased)

First registry release of the sandboxed store: simple products from
content, a token cart, Stripe hosted Checkout, a signed Stripe webhook, a
stock ledger, refunds, flat tax and shipping or Stripe Tax, cleanup cron,
and Block Kit pages for orders, stock and settings.

### Separate plugin id: `dashcommerce-lite`

Lite installs under its own plugin id and registry slug,
`dashcommerce-lite`. The native plugin, `@dashcommerce/core`, keeps the id
`dashcommerce`. The id sets the route prefix
(`/_emdash/api/plugins/dashcommerce-lite/`), the admin pages and the storage
namespace, so the two never collide.

They are still alternatives. **Do not install Lite and core on the same
site**: each runs its own cart, checkout, orders and Stripe webhook, so a
shopper's cart and orders would be split between them. Pick one. To move
from one to the other, uninstall the first, then point the Stripe webhook
at the new plugin's URL (shown on Lite's Settings page).

The existing "DashCommerce Setup" listing (slug `dashcommerce`) is a
separate listing and is not replaced by this release.

### Payment robustness

- Stock changes from webhooks and admin cancels are recorded per order and
  product (`stock_moves`), so a Stripe retry after a failure takes or
  restores stock exactly once.
- A replayed payment event never reopens a refunded, cancelled or on-hold
  order.
- A refund that arrives before the payment is retried by Stripe instead of
  dropped.
- Delayed payment methods (ACH, SEPA debit) wait on hold until Stripe
  confirms or fails the payment; the cleanup task leaves them alone.
- Checking out the same cart twice reuses one order and one Stripe session.

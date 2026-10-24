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

### Sandbox request budget

Every request path stays within the sandbox limit of 10 subrequests
(bridge calls plus fetches), whatever the cart size.

- Checkout reads products in one `content.list` page when that is cheaper
  than one read per line. In catalogs over 100 products a large cart can
  answer `CHECKOUT_CONTINUE`; the storefront kit's `checkout()` repeats the
  request (copy the updated `storefront/dashcommerce.js`).
- Paid and refund webhooks and admin cancels settle the stock lines that
  fit and finish the rest in one-shot cron tasks (`stock-<orderId>-<n>`).
  The webhook outcome is then `paid_stock_pending`, and `paidEffectsAt` is
  set when the last line is taken. A `stock-sweep` task every 15 minutes
  re-schedules anything left over.
- The `stock_moves` collection is gone: moves live on the order, and stock
  rows carry a `rev` used to guard writes.
- The cleanup and sweep tasks are now also scheduled when Lite is loaded
  from the site config, where the install and activate hooks never run.
- Cleanup cancels 3 stale orders per run; the CSV export reads up to 800
  orders.
- Sandboxed plugins on Cloudflare need the Workers Paid plan (Dynamic
  Workers).

### Payment robustness

- Stock changes from webhooks and admin cancels are recorded per order and
  product on the order (`stockMoves`), so a Stripe retry after a failure
  takes or restores stock exactly once.
- A replayed payment event never reopens a refunded, cancelled or on-hold
  order.
- A refund that arrives before the payment is retried by Stripe instead of
  dropped.
- Delayed payment methods (ACH, SEPA debit) wait on hold until Stripe
  confirms or fails the payment; the cleanup task leaves them alone.
- Checking out the same cart twice reuses one order and one Stripe session.

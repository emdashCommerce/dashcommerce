# DashCommerce Lite changelog

Lite is published to the EmDash plugin registry only (it is `private` on
npm), so it keeps its own changelog here.

## 0.2.0

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

### Stock sync covers the whole catalog

Sync on the Stock page used to read only the first 100 published products
(newest first), so in larger shops older tracked products never got a
stock row from Sync (seen on a 146-product test shop). Sync now walks the
whole catalog across clicks, oldest first, one page of 100 products per
click, and keeps its place in plugin KV (`stock-sync`). The toast says how
many products were checked so far and asks for another click; when the
last page is done it says "Checked all N products" and the walk resets.
Each click stays within 8 calls and writes up to 3 rows.

The settings toast now says "Saved 7 of 8 changed settings (1 already
matched)" when a submitted value equals the stored one, instead of
"Saved 7 of 8 changes", which read like a miscount when 9 fields were
submitted.

### Headroom under the sandbox cap

Lite now uses at most 8 of the 10 subrequests per sandboxed invocation,
keeping 2 calls of headroom on every path (a test deployment showed
checkout, the webhook, the cron hook and admin cancel each at exactly 10).

- A paid webhook no longer writes stock rows itself: it marks the order
  paid, clears the cart and queues the stock tasks (outcome
  `paid_stock_pending`). Stock for a paid order is taken on the next cron
  tick, so about a minute after payment; a 20-line order settles within 2
  ticks, because remainders over 5 lines are split into slice tasks that
  run in the same tick.
- Checkout needs a second request (`CHECKOUT_CONTINUE`) sooner in catalogs
  over 100 products; the storefront kit now retries up to 8 times.
- The CSV export reads up to 600 orders, Sync writes 3 stock rows per
  click, and a first settings save of all 9 values takes two clicks.

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
- Cleanup cancels 3 stale orders per run; the CSV export reads up to 600
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

# DashCommerce (sandboxed): design

This package is the sandboxed build of DashCommerce. It is listed on the
EmDash plugin registry as `dashcommerce-lite` (publisher
`did:plc:yakxzbkuhphkc5eepv7p4wrc`, dashcommerce.bsky.social) and installs
from the admin UI. It covers a part of the native plugin (`packages/core`):
simple products read from content, a cart, Stripe hosted Checkout, a signed
Stripe webhook, a stock ledger, refunds, flat tax and shipping, cleanup
cron, and Block Kit pages for orders, stock and settings.

The package directory and npm name stay `packages/lite` and
`@dashcommerce/lite` (private) inside this repo. Everything a site sees uses
the `dashcommerce-lite` id: the registry slug, the route prefix
(`/_emdash/api/plugins/dashcommerce-lite/`), the admin pages and the
plugin's storage namespace.

The id is deliberately different from the native plugin's `dashcommerce`,
so the two never collide on routes, settings or storage. They are still
alternatives: do not install both on one site, because each runs its own
cart, checkout, orders and Stripe webhook.

The separate "DashCommerce Setup" listing (slug `dashcommerce`, 0.1.0, a
static page with install steps for the native plugin, from
`packages/registry-setup`, now in git history) is unchanged. Lite is a new
listing next to it, not a new version of it. See `PUBLISHING.md`.

The native plugin is unchanged and remains the full option.

## Why a separate package

The registry accepts only sandboxed plugins. `packages/core` is
`format: "native"` and depends on things the sandbox does not offer: React
admin pages and widgets, Portable Text blocks, Astro storefront components,
constructor options, and route handlers that return Web `Response` objects
with `Set-Cookie`. Its sandbox entry also minifies to about 171 KB, over the
128 KB per-file cap. Lite is a new entry point built for the sandbox rules
from the start, and it reuses core's logic where that logic is portable.

## Architecture

```
storefront (theme JS)                    EmDash host                     plugin (sandbox isolate)
--------------------                    ------------                    ------------------------
fetch /_emdash/api/plugins/      --->   route dispatcher       --->     src/plugin.ts routes + hooks
  dashcommerce/<route>                  (auth, CSRF, body                 cart-routes.ts
  X-DashCommerce-Cart: <token>          parsing, header                   checkout.ts
                                        allowlist)                        webhook.ts
Stripe  ---- POST stripe/webhook --->                                     admin.ts (Block Kit)
                                        cron scheduler ----------->       cron.ts
                                        ctx.kv / ctx.settings /  <---     shared.ts -> ../core/src/*
                                        ctx.storage / ctx.content
                                        ctx.http (api.stripe.com) <---
```

Source layout (`packages/lite/src`):

| File | Purpose |
| --- | --- |
| `plugin.ts` | Route table and hooks (`SandboxedPlugin` default export). |
| `cart.ts` | Token minting and hashing, the `carts` collection, expiry, pricing with flat tax and shipping, cart view. |
| `cart-routes.ts` | `cart`, `cart/items`, `cart/item`, `cart/clear`. |
| `products.ts` | Reads `products` content entries, checks sellability against the stock ledger, prices them. |
| `stock.ts` | Stock ledger: available stock, deduct at payment, restore on cancel or full refund, sync and manual adjust. |
| `checkout.ts` | Re-prices the cart, writes a pending order, creates the Stripe Checkout Session. |
| `webhook.ts` | Verifies the Stripe signature, dedupes events, marks orders paid, failed, cancelled or refunded. |
| `orders.ts` | Order shape, compare-and-set updates, admin status changes. |
| `cron.ts` | Hourly cleanup of expired carts, stale pending orders and old webhook event ids. |
| `export.ts` | One-time CSV export links and the CSV writer. |
| `admin.ts` | Block Kit Orders, Stock and Settings pages and the recent-orders widget. |
| `settings.ts` | Settings defaults, parsing and validation. One `settings.list()` call per request. |
| `shared.ts` | The list of modules imported from core. |

All storefront routes return JSON. EmDash wraps it as
`{ "success": true, "data": ... }`. Sandboxed routes cannot choose an HTTP
status, so expected failures come back as
`data = { "ok": false, "error": { "code": "...", "message": "..." } }`.
Storefront code must check `data.ok`. Two routes are raw
(`response: "raw"` with `pluginResponse()`): the webhook, so it can answer
400 for a bad signature and 500 when processing fails (Stripe retries), and
the CSV export, so it can return `text/csv` with a download filename.

## Token cart

Sandboxed routes cannot read or set cookies, so the `dashcommerce_sid`
cookie used by core is replaced by a cart token.

- The first `cart/items` call without a valid token mints one: 32 random
  bytes, base64url (43 characters). Every successful cart response returns
  `token`. The storefront stores it (the kit uses localStorage key
  `dashcommerce-cart`) and sends it on later calls in the
  `X-DashCommerce-Cart` header. Routes declare that header in
  `request.headers`, which is the only way a custom header reaches a
  sandboxed handler.
- Carts live in the `carts` storage collection under id `sha256(token)`, as
  `{ cart, expiresAt }`. The raw token is never stored, so reading storage
  does not give anyone a usable token. The hash doubles as the cart id that
  orders keep. Storage (rather than KV) lets the cleanup cron find expired
  carts through the `expiresAt` index in bounded batches.
- Carts expire 30 days after the last write. Expired carts are ignored on
  read and deleted by the hourly cleanup.
- A cart holds at most 20 lines and 99 of one product. This bounds the work
  done in one request (see "Cloudflare limits" below).
- If the store currency changes, existing carts start over empty instead
  of mixing currencies.
- The token is a bearer secret for the cart only. It cannot read orders.
  Order status needs the separate `orderKey` returned by checkout.

Public routes still get EmDash's cross-origin protection: a request with a
different `Origin` gets 403, so another site cannot drive a shopper's cart
from the browser. Same-origin theme code and server-side calls work.

## Stock ledger

Products come from the site's `products` collection with `content:read`
only. The plugin does not request `content:write`, so it cannot change
`stock_quantity` on the entry. It keeps its own count in the `stock`
collection instead, one row per tracked product:

```ts
{ productId, title, onHand, baseline, rev, updatedAt, lastChange, moves }
```

Each order records what it did to stock in `order.stockMoves`, keyed by
product id:

```ts
{ quantity, state: "deducted" | "restored" | "skipped", onHandAfter?, deductedAt?, restoredAt?, reason? }
```

`order.stock` is the target (`deducted` once paid, `restored` after a
cancel or full refund) and `order.stockPending: 1` marks an order whose
lines have not all reached it yet (indexed, so the sweep below can find
them).

- A product is tracked when `manage_stock` is set on the entry.
- `baseline` is the entry's `stock_quantity` when the row was created or
  last reset. While `baseline` equals the current `stock_quantity`, the
  ledger's `onHand` is the available stock. When an editor changes
  `stock_quantity` on the entry, the baseline no longer matches, so the new
  entry value wins and the row resets at the next deduction or sync. Editing
  the product is how a merchant restocks.
- Cart and checkout check availability (`INSUFFICIENT_STOCK`,
  `OUT_OF_STOCK`) but do not reserve stock. Checkout makes no ledger writes.
- Settling (`settle.ts`) moves each pending line toward the target: one
  `getMany` for the rows, then one write per line. A missing row is created
  with `compareAndSet(id, null, ...)`. An existing row is written with
  `updateIf` guarded on its `rev` (bumped on every write), so a concurrent
  change makes the write miss instead of losing an update; the line stays
  pending for the next pass. The order is then written once with
  `compareAndSet` (re-read and merged on conflict), which records all the
  moves of the pass atomically.
- The row write and the order write are two calls. A crash between them is
  covered by `moves` on the stock row: the last 50 move keys
  (`<orderId>:sale`, `<orderId>:restore`) applied to that row, written in
  the same guarded write as `onHand`. A later pass that finds its key there
  only records the move. So a retried webhook or task takes or restores
  each line exactly once.
- When every line is deducted, the pass sets `paidEffectsAt`. If stock ran
  out between checkout and payment and the product does not allow
  backorders, the order still records the payment but goes `on-hold` with a
  `stockShortfall` list, and the admin shows a banner.
- Cancelling a paid order from the admin, or a full refund, sets the target
  to `restored`. Each deducted line is put back once. A line that was never
  taken (no move on the order and no sale key on the row) is recorded as
  `skipped`. A refund or cancel that lands while a large order's deduction
  is still running therefore converges to all stock back.
- Work that does not fit in the request that started it (see Cloudflare
  limits) continues in one-shot cron tasks named
  `stock-<orderId>-<pass>`, each scheduled by the pass before it. A new
  name per pass is needed because EmDash deletes a one-shot task by id
  after it runs. A task that throws is retried by EmDash with backoff. The
  recurring `stock-sweep` task (every 15 minutes) re-schedules any order
  still marked `stockPending`, in case a follow-up task was lost.
- The Stock admin page lists tracked products, syncs rows from content, and
  sets `onHand` by hand.

## Checkout and webhook

`checkout/session`:

1. Loads settings once and the cart by token. Fails with `CART_EMPTY`,
   `STRIPE_NOT_CONFIGURED` and similar codes before any Stripe call.
2. Re-prices every line from the `products` collection and reads the ledger
   for tracked lines in one `getMany`. The browser never supplies prices. If
   the total changed it saves the corrected cart and returns `CART_CHANGED`
   with the new cart so the shopper can review it.
3. Writes a `pending` order, then creates a Checkout Session with core's
   `createCheckoutSession()` (`mode=payment`, `client_reference_id` and
   `metadata.orderId` set to the order id,
   `metadata.source=dashcommerce-lite`).
   The order id and the idempotency key (`dc_checkout_<hash>`) derive from
   the cart id and the cart's `updatedAt`, which increases on every cart
   write. A double submit of the same cart reuses the pending order (the
   order is created with `compareAndSet(id, null, ...)`), sends an identical
   request, and Stripe replays the same session. If the earlier attempt
   for that cart version failed or was cancelled, checkout touches the cart
   and starts a new attempt. A shipping address is collected only when the
   cart has a physical item (read from the product, not the cart line) and
   shipping countries are configured.
4. Returns `{ url, orderId, orderKey, orderNumber }`. The storefront
   redirects to `url`.

`stripe/webhook` (`body: "text"`, header allowlist `stripe-signature`):

1. Verifies the signature over the exact raw body with core's Web Crypto
   `verifyStripeSignature()` (HMAC-SHA256, 5 minute tolerance).
2. Ignores event types it does not handle. Acknowledges an event id it has
   already processed (`stripe_events` collection) without side effects. An
   event id is recorded only after all of its side effects succeeded, or
   were handed to a scheduled follow-up task; if anything throws (including
   failing to schedule that task), the webhook answers 500 and Stripe
   retries.
3. `checkout.session.completed` with `payment_status=paid`, or
   `checkout.session.async_payment_succeeded`: marks the order `paid` and
   `processing`, stores the PaymentIntent id, amount paid, lowercased email,
   shipping address and `livemode`, deletes the cart, and settles stock
   (see Stock ledger), which sets `paidEffectsAt` once every tracked line is
   deducted. Lines that do not fit in the request continue in cron tasks;
   the outcome is then `paid_stock_pending`. If Stripe's `amount_total` or currency does not
   match the order (plus Stripe Tax when enabled), the order goes `on-hold`
   with an `amountMismatch` record for the merchant. Only a `pending` or
   `failed` order, or one on hold for a delayed payment, can become paid: a
   replayed event never moves a refunded, cancelled, on-hold or already paid
   order. When the order is already paid by this session but
   `paidEffectsAt` is unset (an earlier attempt failed part-way), the stock
   and cart steps run again; both are idempotent.
4. `checkout.session.completed` with `payment_status=unpaid` is a delayed
   payment method (ACH, SEPA debit and similar). The order goes `on-hold`
   with `awaitingAsyncPayment: true` and `paymentStatus` stays `pending`.
   The cleanup cron only cancels `pending` orders, so it leaves these alone
   while the payment clears, which can take days. The merchant can only
   cancel such an order. `async_payment_succeeded` then marks it paid and
   takes stock; `async_payment_failed` marks it `failed`.
   `checkout.session.expired` cancels a still-pending order
   (`cancelReason: "session_expired"`).
5. `charge.refunded`: finds the order by `metadata.orderId`, or by the
   PaymentIntent id. Stripe's `amount_refunded` is cumulative, so applying it
   is idempotent and order of delivery does not matter. A partial refund sets
   `partially-refunded`. A full refund sets `refunded`, moves the order to
   `refunded` and restores stock. A charge whose PaymentIntent does not match
   the order is ignored. A refund for an order that is not paid yet (Stripe
   does not guarantee delivery order) answers 500 without recording the
   event, so Stripe delivers it again after the payment event.
6. Order writes use `getVersioned` plus `compareAndSet`, so two concurrent
   deliveries of the same event cannot both apply.

Refunds are issued in the Stripe Dashboard. The order page links there
(test-mode path for test orders). Issuing refunds from the admin would need
a second Stripe write permission and is not included.

The endpoint needs these events: `checkout.session.completed`,
`checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`charge.refunded`. The settings page lists them.

## Tax and shipping

Settings, all optional:

- `flatShipping`: one shipping charge per order in minor units, added only
  when the cart has a physical item. Sent to Stripe as a fixed
  `shipping_options` rate named "Shipping".
- `flatTaxPercent` (0 to 50): applied to subtotal plus shipping and sent as
  a separate `Tax (X%)` line item, so the Stripe total matches the cart.
- `automaticTax`: turns on Stripe Tax (`automatic_tax[enabled]=true`, line
  items `tax_behavior=exclusive`) and hides the flat rate. The cart shows
  "calculated at checkout". The webhook adds Stripe's
  `total_details.amount_tax` to the expected total and records it on the
  order. Stripe Tax must be set up on the Stripe account. The flat shipping
  rate is sent with `tax_behavior=exclusive` as well.

## Cleanup cron

`plugin:install` and `plugin:activate` schedule task `cleanup` at `@hourly`
and `stock-sweep` every 15 minutes. A plugin listed in the site config
(`sandboxed: [...]`) never gets those hooks, so the cart routes and admin
pages also check a `cronVersion` setting they already read and, when it is
missing or old, schedule both tasks (an upsert by name, so repeating it is
harmless) and record the version. `cleanup` runs:

- deletes up to 100 expired carts (`expiresAt` index),
- cancels up to 3 orders still `pending` after 25 hours
  (`cancelReason: "stale"`; Checkout Sessions expire after 24 hours, so
  these are sessions whose expiry webhook never arrived), using `updateIf`
  so a payment that lands at the same moment wins. Orders waiting for a
  delayed payment are `on-hold`, so they are not touched,
- deletes up to 100 `stripe_events` ids older than 30 days.

Batches keep each run inside the per-invocation limits. A backlog clears
over several runs.

## Admin

- Orders page: totals for paid, awaiting payment and refunded; a status
  filter; a paged table that keeps the filter; search by exact order
  number, email, PaymentIntent id or Checkout Session id; CSV export.
- Order detail: items, subtotal, shipping, tax, refunded amount, stock
  state, banners for amount mismatch, stock shortfall and refunds, a link to
  the payment in Stripe, and allowed status changes.
- Recent orders widget (`recent-orders`) for the dashboard.
- Stock page and Settings page.

CSV export: private plugin routes need the `X-EmDash-Request` header, which
a plain download link cannot send. The Export button writes a single-use
grant to KV (`export:<sha256(token)>`, 5 minute TTL) and shows a "Download
CSV" link to the public raw route `orders/export?token=...`. A used,
expired or unknown token gets 403. The export reads at most 800 orders
(8 pages of 100, to stay within the request budget) and sets `x-dashcommerce-truncated: true` when there were
more. Cells that start with `=`, `+`, `-`, `@`, tab or carriage return are
prefixed with `'` so spreadsheets do not run them as formulas.

## Code shared with core

Lite imports these modules from `packages/core/src` through
`src/shared.ts`; the Lite build inlines them:

| Core module | Used for |
| --- | --- |
| `money.ts` | Integer minor-unit money, formatting. |
| `cart/calculate.ts` (`recalculate`) | Cart totals. |
| `cart/store.ts` (`newCart`) | Empty cart shape. |
| `products/normalize.ts` | snake_case product fields to `ProductFields`. |
| `products/pricing.ts` (`resolvePrice`) | Price for a currency. |
| `stripe/client.ts`, `stripe/checkout-sessions.ts` | Stripe form encoding, Checkout Session creation via `ctx.http`. |
| `stripe/webhook-verify.ts` | Signature verification. |
| `orders/status.ts` (`canTransition`) | Order state machine. |
| `util/ids.ts` (`randomId`) | Ids and order keys. |
| `types.ts` | `CartState`, `CartLineItem`, `OrderStatus`, `PaymentStatus`, `ProductFields`. |

None of these import React, Astro, `node:*` or the `emdash` runtime (only
`import type`). `test/unit/shared-imports.test.ts` walks the import graph
from `src/plugin.ts` and fails if a runtime package import appears, so a
change in core that would break the sandbox build is caught in CI. Core
itself is not modified by this package.

Also used: `derivePaymentStatus` and `deriveOrderStatusFromRefunds`
(`orders/status.ts`) for refunds, and the `PricingPolicy` option of
`recalculate` for flat or Stripe tax.

Not shared (native-only or out of scope here): React admin, Astro
components, cookie session helpers, coupons, shipping zones, tax tables,
variants, subscriptions, Connect, emails, downloads.

## Permissions

```jsonc
"capabilities": ["content:read", "network:request"],
"allowedHosts": ["api.stripe.com"]
```

- `content:read`: read prices and stock settings from the site's
  `products` collection. Without it the plugin would need its own product
  store and editor.
- `network:request` limited to `api.stripe.com`: create Checkout Sessions.
  Stripe sends webhooks to us, so no other host is needed.
- Not requested: `content:write` (stock uses the plugin's own ledger),
  `email:send` (no order emails; Stripe can send receipts), `users:read`,
  `media:read`.
- `ctx.settings`, `ctx.kv`, `ctx.cron` and the four declared storage
  collections (`orders`, `carts`, `stock`, `stripe_events`) need no
  capability.
- Stripe keys are `type: "secret"` settings, encrypted by EmDash with
  `EMDASH_ENCRYPTION_KEY`. The settings page shows only whether a key is
  set. A Stripe restricted key with write access to Checkout Sessions is
  enough.
- Public routes: `cart`, `cart/items`, `cart/item`, `cart/clear`,
  `checkout/session`, `order`, `stripe/webhook`, `orders/export` (token
  gated). `admin` is private and uses the default `plugins:manage`
  permission.
- Requires EmDash `>=1.3.0 <2.0.0`.

## Storefront usage

Base path: `/_emdash/api/plugins/dashcommerce-lite`.

| Route | Method | Body / query | Returns (`data`) |
| --- | --- | --- | --- |
| `cart` | GET | (header) | `{ ok, token, cart }`, `token: null` when there is no cart |
| `cart/items` | POST | `{ productId, quantity? }` | `{ ok, token, cart }` |
| `cart/item` | POST | `{ lineId, quantity }` (0 removes) | `{ ok, token, cart }` |
| `cart/clear` | POST | `{}` | `{ ok, token, cart }` |
| `checkout/session` | POST | `{ email? }` | `{ ok, url, orderId, orderKey, orderNumber }` |
| `order` | GET | `?id=&key=` | `{ ok, order }` |

`productId` is the content entry id of a published `products` entry. The
cart view has `subtotal`, `shippingTotal`, `taxTotal`, `total` and
`taxAtCheckout`.

Sandboxed plugins cannot inject scripts into pages, so themes include the
storefront kit themselves (`storefront/`):

- `dashcommerce.js` (with `dashcommerce.d.ts`): a dependency-free ES module,
  about 6.5 KB unminified. `createClient()` returns `getCart`, `addItem`,
  `updateItem`, `removeItem`, `clear`, `checkout`, `redirectToCheckout`,
  `getOrder` and `waitForPayment`. It stores the token, checks `data.ok`,
  throws `DashCommerceError` with the route's `code`, and fires a
  `dashcommerce:cart` event on `window` after every change. Helpers:
  `orderFromQuery`, `formatMoney`.
- `astro/AddToCart.astro`, `astro/CartCount.astro`, `astro/Cart.astro`,
  `astro/CheckoutSuccess.astro`: unstyled components built on the module.
  Copy them to `src/components/` and the module to `src/lib/` in a theme.

```js
import { createClient } from "./lib/dashcommerce.js";

const shop = createClient();
await shop.addItem(productId, 1);
await shop.redirectToCheckout();
```

The success page reads `order` and `key` from its query string (the
default success URL is `/checkout/success?order={ORDER_ID}&key={ORDER_KEY}`).
The webhook may land a moment after the redirect, so `waitForPayment` polls
`order` every 1.5 seconds for up to 20 seconds while `paymentStatus` is
`pending`, then clears the stored cart token once paid.

The starter (`packages/starter`) carries copies of the kit and switches to
it when built with `DASHCOMMERCE_EDITION=sandboxed` (default `native`, which
keeps core). The starter is mirrored to `emdashCommerce/starter` as a flat
repo by `.github/workflows/sync-starter.yml`, so it cannot import from this
private package; `bun run kit:sync` refreshes the copies and
`test/unit/starter-kit.test.ts` fails when they drift.

`test/unit/storefront.test.ts` runs the module against the real route
handlers. The Astro components compile in an Astro 6 build; they have not
been run in a browser test.

## Cloudflare limits

Sandboxed plugins run in Dynamic Workers (Worker Loader), which need the
Workers Paid plan. Each sandboxed invocation gets 50 ms CPU and 10
subrequests. Every `ctx.*` call (storage, content, settings, kv, cron, log
and `http.fetch`) is an RPC to EmDash's bridge, and the code assumes each
counts toward the 10. Lite keeps every request path at 10 or fewer
regardless of cart size:

- `budget.ts` wraps the context and counts calls. Logging is skipped when
  no call is left, and the stock and checkout code size their batches from
  what remains.
- Checkout reads products with one `content.list` page (100 entries) when
  that is cheaper than a `content.get` per line, so a shop with up to 100
  products prices any cart in one read. In a larger catalog, when the
  products do not fit in one request, checkout saves the products read so
  far on the cart (`checkoutPrep`, valid 5 minutes and only for that cart
  version) and answers `CHECKOUT_CONTINUE`. The storefront kit repeats the
  request (up to `MAX_CHECKOUT_REQUESTS`). A 20-line cart in a 1,000
  product catalog takes 4 requests. The 20-line cap stays.
- Paid and refund webhooks and admin cancels settle as many stock lines as
  fit and schedule the rest (see Stock ledger).
- Cleanup cancels 3 stale orders per run, the sweep handles 5 orders, the
  CSV export reads 8 pages, and the settings form writes only changed
  values.

`test/unit/bridge-calls.test.ts` counts calls (including log and cron) at
1, 5, 10 and 20 lines, with and without stock tracking:

| Path | Calls per request |
| --- | --- |
| `cart` (GET) | 2 (4 on the first request that schedules cron) |
| `cart/items` | 4, or 5 for a stock-tracked product |
| `checkout/session`, catalog up to 100 products | 7, or 8 with tracked lines, in one request |
| `checkout/session`, 1,000 products, 20 lines | 4 requests, at most 10 each |
| `stripe/webhook` paid or async succeeded | 7 untracked; 9 or 10 tracked, then follow-up tasks of at most 10 (20 tracked lines: 3 tasks) |
| `stripe/webhook` full refund | 5 untracked; 8 or 10 tracked, then at most 10 per task (20 lines: 3 tasks) |
| cron `cleanup`, `stock-sweep`, `stock-*` | at most 10 |
| admin pages and actions | at most 10 |

Before this, a paid webhook made 12 calls for one tracked line and 69 for
20, and checkout made 26 at 20 lines.

CPU: the hot paths are a SHA-256 of the token, HMAC verification and small
JSON work. Unit timings are well under a millisecond.

## Bundle size

`emdash-plugin bundle` output for 0.2.0: `backend.js` 58.6 KB, total
66.5 KB across 4 files (caps: 128 KB per file, 256 KB total). The tarball
is about 22 KB gzipped. No zod; input validation is hand-written in `validate.ts`.
`bun run size` prints the numbers and fails above a 96 KB working budget
for `backend.js`. The storefront kit is not part of the bundle.

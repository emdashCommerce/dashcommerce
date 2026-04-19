# DashCommerce Architecture Reference

Dense companion to `RESUME.md`. If you know the high level and need to look up a specific detail, this is the map.

## Two-process model

Every dashcommerce feature has code in two worlds:

| World | File(s) | Context | What goes here |
|---|---|---|---|
| Build-time (Vite) | `src/index.ts` | Host's `astro.config.mjs` imports | Descriptor factory — metadata, capabilities, storage schema, admin/components entry specs. Side-effect free. |
| Runtime (server) | `src/sandbox-entry.ts` + everything it imports | Loaded by emdash runtime on request | `definePlugin({ hooks, routes })`. Must be sandbox-safe. |
| Browser (admin) | `src/admin/entry.tsx` + pages + widgets | `@emdash-cms/admin` mounts these | React components; `usePluginAPI()` calls our routes. |
| Server (SSR site) | `src/astro/index.ts` + components | Loaded by the host's templates | Astro components + React islands for storefront rendering + checkout. |

The descriptor (`index.ts`) is the only thing the host imports directly. Everything else is loaded via the string specifiers in the descriptor (`entrypoint`, `adminEntry`, `componentsEntry`).

## Data flow: happy-path checkout

```
┌───────────┐        ┌──────────────────┐        ┌────────────┐
│  Browser  │ ──────▶│  routes/cart.ts  │ ──────▶│  KV: cart  │
│  cart UI  │  fetch │  (public routes) │  save  │            │
└───────────┘        └──────────────────┘        └────────────┘
      │                      │
      │  click Checkout      │  re-price server-side, lock stock
      ▼                      ▼
┌──────────────────┐        ┌─────────────────────┐
│  checkout page   │        │  routes/checkout.ts │───POST───▶ Stripe /payment_intents
│   (Astro+React)  │        └─────────────────────┘               │
└──────────────────┘                                              │
      │                                                           │
      │  Stripe Elements confirm(clientSecret, return_url)        │
      ▼                                                           │
┌──────────────┐                                          payment_intent.succeeded
│ return to    │                                                  │
│ thank-you    │ ◀──── poll ──── order record (written by webhook below)
└──────────────┘
                                                                  │
                                                                  ▼
                                                       ┌──────────────────────┐
                                                       │ routes/webhook.ts    │
                                                       │ verify HMAC          │
                                                       │ orders.create        │
                                                       │ decrement stock      │
                                                       │ ledger               │
                                                       │ release locks        │
                                                       │ coupon usage++       │
                                                       │ send receipt email   │
                                                       │ subscription create  │
                                                       │ download grants      │
                                                       └──────────────────────┘
```

## Storage key map

| Collection / KV prefix | Shape | Written by | Read by |
|---|---|---|---|
| content `products` | `{ ...ProductFields }` | admin editor + migration scripts | storefront SSR, cart pricing, admin |
| storage `product_variants` | `ProductVariant` | admin variant editor | cart pricing, inventory decrement |
| storage `orders` | `Order` | webhook (`orders.create`) | admin Orders, customer order lookup |
| storage `order_items` | `OrderItem` | webhook | admin Order Detail, refund flow |
| storage `refunds` | `Refund` | admin Refund action | admin Order Detail |
| storage `customers` | `Customer` | webhook (upsert by email) | admin, customer portal |
| storage `customer_addresses` | `CustomerAddress` | webhook, customer portal | checkout address picker |
| storage `coupons` | `Coupon` | admin Coupons page | cart coupon apply |
| storage `coupon_usage` | `CouponUsage` | webhook (post order) | validation (per-customer limit) |
| storage `shipping_zones` | `ShippingZone` | admin Shipping | cart shipping calculator |
| storage `shipping_methods` | `ShippingMethod` | admin Shipping | cart shipping calculator |
| storage `shipping_classes` | `ShippingClass` | admin Shipping | product.shippingClassSlug lookup |
| storage `tax_rates` | `TaxRate` | admin Tax (table mode) | tax calculator |
| storage `subscriptions` | `Subscription` | webhook (`customer.subscription.*`) | admin, customer portal |
| storage `subscription_invoices` | `SubscriptionInvoice` | webhook (`invoice.*`) | admin, dunning |
| storage `reviews` | `Review` | public submit route | admin moderation, product page |
| storage `review_summaries` | `ReviewSummary` | moderation approve | product card/page (fast read) |
| storage `vendors` | `Vendor` | admin Vendors | split calc, webhook `account.updated` |
| storage `vendor_payouts` | `VendorPayout` | webhook (`payout.*`) | admin Vendors |
| storage `inventory_ledger` | `InventoryLedgerEntry` | webhook + admin adjustments | admin, reporting |
| storage `download_grants` | `DownloadGrant` | webhook (digital orders) | download serve route |
| KV `cart:{sessionId}` | `CartState` | cart routes | cart routes, checkout, webhook |
| KV `lock:{orderDraftId}` | `StockLock` | checkout route | sumActiveLocksForProduct, cron sweeper |
| KV `draft:{orderDraftId}` | `CartState` snapshot | checkout route | webhook (cart recovery) |
| KV `settings:<key>` | varies | admin Settings | everywhere |
| KV `state:<key>` | varies (signing secrets, counters) | install hook | everything needing keys/counters |
| KV `counter:<name>` | integer | orders.create | orders.create |

## The "sandbox-safe" contract in code

When adding a new file, ask:

1. **Is this module imported by `sandbox-entry.ts` directly or transitively?** If yes, it's runtime. If no (e.g. it's only imported by `admin/*` or `astro/*`), Node is fine.
2. If runtime, confirm:
   - No `import X from "node:*"` or bare `"fs" | "path" | "crypto" | "child_process" | "os" | "stream" | "util"` (except `node:crypto.subtle` equivalents — use global `crypto.subtle`).
   - No `require()`.
   - Only `ctx.http.fetch` (never global `fetch`).
   - No `process.env` (all config via `ctx.kv` settings).
3. Types imported from `emdash` are always safe — they compile away.

## Key type dependencies

```
money.ts   ←───  types.ts  ←───  (most everything)
types.ts   ←───  products/*, cart/*, coupons/*, shipping/*, tax/*, orders/*, ...
```

`storage-collections.ts` depends only on emdash types. `seed/products-collection.ts` is standalone except for types.

Avoid importing back up the dependency tree — `types.ts` must not import from `cart/*`, etc.

## Error handling

- Validation errors in `hooks/content.ts` throw `ProductValidationError` (subclass of `Error`). emdash surfaces message to the editor.
- Stripe errors throw `StripeApiError` with status + body.
- Webhook verify failures return `false`, caller returns `new Response("bad signature", { status: 400 })`.
- Routes can throw; emdash renders the error. For client-visible errors, return `{ error: "..." }` with status 200 (or use `new Response(..., { status: 400 })` for HTTP semantics).

## What NOT to build (yet)

- **Admin design system.** Use `@emdash-cms/admin` primitives.
- **Own state management / stores.** React `useState` + route calls are enough.
- **Own database migrations.** emdash handles schema changes for the content collection via `seed.json` + `bun emdash seed`. Plugin storage is schema-free.
- **Currency auto-conversion.** Merchants price per currency. No FX.

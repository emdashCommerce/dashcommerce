# @dashcommerce/core

The e-commerce plugin for [EmDash CMS](https://github.com/emdash-cms/emdash).

**Current npm version: 0.1.2.** See the [monorepo README](../../README.md) for the full feature list and quick start, or [dashcommerce.dev/docs](https://dashcommerce.dev/docs) for guides. Live demo: [demo.dashcommerce.dev](https://demo.dashcommerce.dev).

## Package exports

| Entry | Context | Purpose |
|---|---|---|
| `.` | Vite / build time | Descriptor factory (`dashcommerce()`) — imported in `astro.config.mjs`. Side-effect-free. |
| `./sandbox` | Runtime server | `definePlugin({ hooks, routes })` loaded by the emdash runtime. Sandbox-safe. |
| `./admin` | Browser | React admin pages + dashboard widgets + field widgets. |
| `./astro` | Host SSR | `blockComponents` registry for Portable Text block renderers. |
| `./astro/components/*` | Host SSR | Storefront Astro components (`<ProductCard>`, `<CartSummary>`, etc.). |
| `./astro/islands/*` | Host SSR + client | React islands (`CartDrawerIsland`, `CheckoutIsland`, etc.). |

## Install

Four steps to add DashCommerce to an existing EmDash + Astro site:

```sh
bun add @dashcommerce/core
```

Register the plugin in `astro.config.mjs`:

```ts
import { dashcommerce } from "@dashcommerce/core";

emdash({ plugins: [dashcommerce()] });
```

Merge the products collection + taxonomies into your seed file, then re-apply:

```sh
bunx dashcommerce-merge-seed
bun emdash seed --on-conflict=update
```

Open `/_emdash/admin/plugins/dashcommerce/settings` and paste your Stripe test keys.

**Want sample data?** Add `--with-demo-catalog` to the merge step to seed six demo products (one per product type) plus `product_category` and `product_tag` terms, so the admin isn't empty on first boot:

```sh
bunx dashcommerce-merge-seed --with-demo-catalog
bun emdash seed --on-conflict=update
```

Re-running is safe — existing products with matching ids are preserved. Swap or delete the demo entries any time from the Products admin.

For a fully-wired reference setup (seed data, storefront pages, Stripe keys), see [`@dashcommerce/starter`](../starter). Full walkthrough: [dashcommerce.dev/docs/getting-started](https://dashcommerce.dev/docs/getting-started).

## Seed merge CLI

`@dashcommerce/core` ships a `dashcommerce-merge-seed` binary (on your `PATH` via `node_modules/.bin`). It writes the `products` collection and `product_category` / `product_tag` taxonomies into your EmDash `seed.json`, replacing any prior DashCommerce entries by slug / name. Unrelated keys in the seed file (settings, content, menus, other collections) are left intact.

```sh
# Typical one-liner after emdash init (fresh DB)
bunx dashcommerce-merge-seed && bun emdash seed --on-conflict=update
```

Or add to `package.json`:

```json
"scripts": {
  "bootstrap": "dashcommerce-merge-seed && bun emdash seed --on-conflict=update"
}
```

Why `--on-conflict=update`? On a first run it's a no-op, but subsequent runs (after a DashCommerce release that tweaks the `products` schema) need it to update the collection in place rather than skipping it.

Options: `--seed <path>` (override file), `--cwd <dir>`, `--with-demo-catalog` (append 6 demo products + curated taxonomy terms). When `--seed` is omitted the CLI uses the same default resolution as `emdash seed`: `.emdash/seed.json` if present, otherwise `package.json` → `emdash.seed`.

Prefer to assemble the seed in TypeScript? Import `mergeDashCommerceSeed(seedObject, { withDemoCatalog })` from the package root — same dedupe rules as the CLI. The demo catalog is also exported directly as `DEMO_PRODUCTS`, `DEMO_PRODUCT_CATEGORY_TERMS`, and `DEMO_PRODUCT_TAG_TERMS` for cherry-picking.

## Runtime surface

### Public routes (storefront)

All paths mount under `/_emdash/api/plugins/dashcommerce/`.

```
GET    /cart                              Current cart (creates if missing; re-runs recalculate)
POST   /cart/items                        Add line item
PATCH  /cart/item?lineId={id}             Update qty
DELETE /cart/item?lineId={id}             Remove line
DELETE /cart/clear                        Empty cart (keeps session)
POST   /cart/currency                     Switch currency (empty cart only)
POST   /cart/coupon                       Apply coupon
DELETE /cart/coupon/remove?code={code}    Remove coupon
POST   /cart/shipping-location            Set country + postal (hosted checkout pre-flight)
POST   /cart/shipping-address             Full address (embedded checkout)
POST   /cart/contact                      Email + billing address
POST   /cart/shipping-methods             List rates for current ship-to
POST   /cart/shipping-method              Choose method id
GET    /cart/restore?token={t}            Abandoned-cart recovery link

POST   /checkout/create-intent            Embedded Elements: create PaymentIntent
POST   /checkout/create-session           Hosted Checkout: create Checkout Session
GET    /checkout/mode                     Which mode is active (hosted | embedded)
POST   /checkout/webhook                  Stripe webhook sink (signature-verified)

GET    /orders/by-draft?id={draftId}      Poll order status after checkout

GET    /downloads/serve?token={t}         Signed-URL download delivery

GET    /reviews/list?productId={id}       Paginated reviews
POST   /reviews/item                      Submit a review (moderation queue)

GET    /config-check                      Read-only health check (Stripe keys present, etc.)
```

### Admin-gated routes

Same prefix, gated by emdash's admin auth:

```
GET    /admin/settings                    Read all settings:* keys
POST   /admin/settings                    Write (validated via schema)
POST   /admin/stripe/ping                 Live-key sanity check
GET    /admin/orders, /admin/orders/:id   Order list + detail
POST   /admin/orders/:id/refund           Full or partial refund
PATCH  /admin/orders/:id/status           Transition order status (triggers review-request etc.)
GET    /admin/customers …                 Customer CRUD
GET    /admin/reports/revenue             Range-sliced revenue with comparison
GET    /admin/reports/top-products        Best sellers by qty or revenue
GET    /admin/reports/top-customers       Lifetime-value leaderboard
GET    /admin/reports/mrr                 Active subscription MRR by currency
… plus coupons, vendors, shipping zones/methods, tax rates, subscriptions, reviews moderation, menu, customer-portal-session
```

### Hooks

- `content:beforeSave` on the `products` collection — field validation (price map, variants, stock, shipping class)
- `cron` — stock-lock sweep (5 min), abandoned-cart reminders (hourly), subscription renewals dry-check
- `plugin:install` — seed default settings (`taxMode=flat`, currencies, download TTLs, etc.)
- `plugin:activate` — assert Stripe keys present; emit config warnings if not

### Plugin storage collections

19 collections declared in [`storage-collections.ts`](./src/storage-collections.ts):

```
orders · order_items · order_refunds · customers · customer_addresses
product_variants · inventory_ledger · stock_locks
coupons · coupon_usages · shipping_zones · shipping_methods · shipping_classes
tax_rates · reviews · subscriptions · vendors · vendor_payouts · download_grants
```

Plus one *content* collection declared by the host via `defineProductsCollection()`:

```
products  (lives on host content, not plugin storage — emdash restriction)
```

### KV namespaces

Prefixes `ctx.kv` uses under the hood:

```
settings:*                  plugin configuration (tax mode, currencies, Stripe keys, etc.)
cart:{sessionId}            active carts (30-day TTL via cookie)
lock:{productId}:{variant}  stock soft-locks during checkout
abandoned:{sessionId}       abandoned-cart marker (sent / not sent)
email-throttle:{category}:* per-customer email de-duplication keys
```

## Admin surface

React pages served at `/_emdash/admin/plugins/dashcommerce/*`:

- Orders (list, detail, refund, status transitions)
- Customers (list, detail, order history)
- Coupons (CRUD + usage reports)
- Shipping (zones + methods + classes)
- Tax (mode + flat rate + rate table + Stripe Tax status)
- Subscriptions (list, detail, pause/resume, invoice history)
- Reviews (moderation queue, bulk approve/reject)
- Vendors (invite, onboarding status, payout history)
- Menus (storefront nav editor, nested up to 4 levels)
- Reports (revenue + top products + top customers + MRR)
- Settings (all `settings:*` keys with per-key validation)
- Dashboard widgets: Revenue, Low Stock, Recent Orders, Pending Reviews, Failed Renewals

Field widgets (for use in any collection via `widget: "dashcommerce:<name>"`):

- `vendor-select` — picks a vendor from `vendors` storage
- `price-map` — multi-currency price input, respects `settings:enabledCurrencies`

Portable Text blocks (for any rich-text field):

- `product-embed` — single product card by slug
- `product-grid` — N products from a category slug
- `review-quote` — inline quote of an approved review

## Events & emails

The plugin sends these transactional emails via `ctx.email.send` (HTML + plain text):

| Event | Template | Triggered by |
|---|---|---|
| Order receipt | `emails/receipt` | Webhook `charge.succeeded` / `checkout.session.completed` |
| Refund | `emails/refund` | Webhook `charge.refunded` or admin refund POST |
| Subscription renewed | `emails/subscription-renewed` | Webhook `invoice.payment_succeeded` (cycle only) |
| Dunning | `emails/dunning` | Webhook `invoice.payment_failed` |
| Abandoned cart | `emails/abandoned-cart` | Hourly cron, per `settings:abandonedCartDelayHours` |
| Review request | `emails/review-request` | Order status → `completed` on physical items |
| Vendor invite | `emails/vendor-onboarding` | `startOnboarding()` in `vendors/onboarding.ts` |
| Vendor activated | `emails/vendor-onboarding` | Webhook `account.updated` when `chargesEnabled` flips true |
| Vendor payout | `emails/vendor-payout` | Webhook `payout.paid` |

All senders are idempotent via `ctx.kv` de-dup keys.

## Development

```sh
bun install
bun run typecheck
bun run build          # tsdown bundles index + sandbox-entry + admin/entry
bun run dev            # tsdown --watch
bun test               # 66 tests across money / cart / coupons / webhook / tokens / split
```

`src/astro/` is shipped as source — it is NOT bundled. It imports `.astro` components that rolldown can't compile; the host's Astro build resolves the imports at consumer build time.

## License

MIT

# DashCommerce

The WooCommerce-equivalent commerce plugin for [EmDash CMS](https://github.com/emdash-cms/emdash) — Cloudflare's Astro-native WordPress successor.

Typed end-to-end, sandbox-safe, edge-renderable. Every feature category Woo ships (products, cart, Stripe checkout, orders, shipping, tax, coupons, subscriptions, downloadables, reviews, multi-vendor) lands in a single plugin.

- 📘 Documentation: <https://dashcommerce.dev/docs>
- 💬 Issues: <https://github.com/emdashCommerce/dashcommerce/issues>
- 📦 npm: [`@dashcommerce/core@0.1.2`](https://www.npmjs.com/package/@dashcommerce/core)

## Status

**v0.1.2 on npm.** The v1.0 feature roadmap is code-complete (cart through Connect, hosted checkout, transactional email, starter theme). SemVer: `0.x` may include minor breaking changes until **1.0.0** — see root `CHANGELOG.md`.

## What's in the box

| Area | What ships |
|---|---|
| **Products** | Simple, variable (size/color/etc), grouped, external/affiliate, subscription, digital-download — one collection, one type switch |
| **Multi-currency** | Per-product price maps, customer-selected currency at cart, per-currency minor-units handling |
| **Cart & Checkout** | Hosted Stripe Checkout (default) + embedded Payment Element fallback; Apple/Google Pay; guest + logged-in |
| **Orders** | Admin dashboard with refund / partial-refund UI, order timeline, draft-to-paid pipeline |
| **Customers** | Address book, order history, self-service portal (email-link, no password needed for first access) |
| **Coupons** | Fixed/percent × cart/product, free-shipping, exclusions, usage limits, per-customer caps |
| **Shipping** | Multi-zone, flat-rate / free / local-pickup / weight-based; per-product shipping classes |
| **Tax** | Flat-rate, rate-table (by country/region), or Stripe Tax (automatic); tax on shipping toggle |
| **Inventory** | Soft-locks during checkout prevent overselling; low-stock alerts; backorder policy per product |
| **Subscriptions** | Stripe Subscriptions, trials, upgrade/downgrade, pause/resume, dunning, customer portal |
| **Digital downloads** | Signed-URL token downloads, TTL + max-use enforcement, per-order grants |
| **Reviews** | Moderation queue, verified-purchase badge, review aggregates on product pages |
| **Multi-vendor** | Stripe Connect Express onboarding, single-vendor-per-order splits, platform fee, vendor payouts |
| **Abandoned cart** | Cron-driven reminder emails with signed restore links |
| **Transactional email** | Receipt, refund, subscription renewal, dunning, abandoned cart, review request, vendor invite/activation/payout — HTML + plain text |
| **Reports** | Revenue / top products / top customers / MRR inside the admin dashboard |
| **Admin UI** | 12 React pages + 5 dashboard widgets + 2 field widgets + 3 Portable Text blocks |

## Packages

| Package | Description |
|---|---|
| [`@dashcommerce/core`](./packages/core) | The plugin — hooks, routes, admin UI, storefront islands |
| [`@dashcommerce/starter`](./packages/starter) | Reference EmDash storefront that exercises every feature |

The marketing / docs site source also lives in this monorepo under [`site/`](./site) and serves <https://dashcommerce.dev>.

## Quick start

### Already have an EmDash site? (30 seconds)

```sh
bun add @dashcommerce/core
```

Register the plugin in `astro.config.mjs`:

```ts
import { dashcommerce } from "@dashcommerce/core";

emdash({ plugins: [dashcommerce()] });
```

Merge the products collection + taxonomies into your seed file and re-apply:

```sh
bunx dashcommerce-merge-seed
bun emdash seed --on-conflict=update
```

Open `/_emdash/admin/plugins/dashcommerce/settings` and paste your Stripe test keys.

Want sample data to play with? Add `--with-demo-catalog` to seed six example products (one per type) plus curated category/tag terms:

```sh
bunx dashcommerce-merge-seed --with-demo-catalog
bun emdash seed --on-conflict=update
```

The merge step is idempotent — it only replaces DashCommerce's own entries (the `products` collection, `product_category` / `product_tag` taxonomies) and, with `--with-demo-catalog`, only appends demo products whose ids aren't already in your seed. Everything else is preserved. If you prefer to assemble the seed in code, import `mergeDashCommerceSeed(seed, { withDemoCatalog })` from `@dashcommerce/core`.

### Starting fresh?

```ts
// astro.config.mjs
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";
import { local } from "emdash/storage/local";
import { dashcommerce } from "@dashcommerce/core";

export default defineConfig({
  integrations: [
    emdash({
      database: sqlite({ url: "file:./data.db" }),
      storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
      plugins: [dashcommerce()],
    }),
  ],
});
```

```sh
bun emdash init
bunx dashcommerce-merge-seed
bun emdash seed --on-conflict=update
bun dev
```

Or clone [`@dashcommerce/starter`](./packages/starter) for a fully-wired storefront with demo catalog.

Full walkthrough: [Getting started](https://dashcommerce.dev/docs/getting-started) · [Stripe setup](https://dashcommerce.dev/docs/stripe).

## Architecture at a glance

```
astro.config.mjs
  └─ emdash({ plugins: [dashcommerce()] })
       │
       ├─ Vite build ──► packages/core/src/index.ts          # descriptor only, side-effect-free
       │
       └─ Runtime    ──► packages/core/src/sandbox-entry.ts  # hooks + routes
                          │
                          ├─ routes/cart.ts        (public)
                          ├─ routes/checkout.ts   (public)
                          ├─ routes/webhook.ts    (public; Stripe-signed)
                          ├─ routes/admin-api.ts  (admin-gated)
                          └─ …12 more
```

Hard rules the sandbox entry and everything it imports obey:

- No Node built-ins (`fs`, `crypto`, `node:*`) — crypto via `crypto.subtle`, HTTP via `ctx.http.fetch`
- All money as integer minor units (`Money = { currency, amount }`), ISO 4217; mixed-currency ops throw
- Every Stripe webhook is idempotent via unique-indexed Stripe IDs; duplicates return HTTP 200
- Webhook signature verification happens before any side effect
- Cart re-prices server-side on every mutation *and* on every read — no client-sent prices trusted

## Development

```sh
bun install
bun run typecheck
bun run build
bun test          # 66 tests across money / cart / coupons / webhook / tokens / split
```

Per-package loop:

```sh
cd packages/core && bun run dev    # tsdown --watch
cd packages/starter && bun run dev # Astro on :4321
```

Stripe webhook forwarding for local dev:

```sh
stripe listen --forward-to localhost:4321/_emdash/api/plugins/dashcommerce/checkout/webhook
```

## Contributing

Pre-release, so the surface is still shifting. Small PRs welcome; large new features please open an issue first so we can align with the roadmap in `CHANGELOG.md`.

## License

MIT

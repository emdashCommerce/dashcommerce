# DashCommerce

The WooCommerce-equivalent commerce plugin for [EmDash CMS](https://github.com/emdash-cms/emdash) — Cloudflare's Astro-native WordPress successor.

Typed end-to-end, sandbox-safe, edge-renderable. Every feature category Woo ships (products, cart, Stripe checkout, orders, shipping, tax, coupons, subscriptions, downloadables, reviews, multi-vendor) lands in a single plugin.

- 📘 Documentation: <https://dashcommerce.dev/docs>
- 💬 Issues: <https://github.com/emdashCommerce/dashcommerce/issues>
- 📦 npm: [`@dashcommerce/core@0.1.2`](https://www.npmjs.com/package/@dashcommerce/core)

## Status

**v0.1.5 on npm.** The v1.0 feature roadmap is code-complete (cart through Connect, hosted checkout, transactional email, starter theme). SemVer: `0.x` may include minor breaking changes until **1.0.0** — see root `CHANGELOG.md`.

## Compatibility & Migration

### EmDash Version Compatibility

| DashCommerce Version | Supported EmDash Versions |
|---|---|
| **0.2.x (latest)** | EmDash `^0.37.0` (0.37.0 - 0.37.x) |
| 0.1.x (maintenance) | EmDash `^0.28.0` (0.28.0 - 0.28.x) |

**⚠️ Important**: Do NOT mix DashCommerce 0.2.x with EmDash < 0.37.0, or DashCommerce 0.1.x with EmDash >= 0.29.0. Incompatible versions will fail with clear error messages at plugin initialization.

### Upgrade Path: 0.1.x → 0.2.x

**Prerequisites**: Backup your database and verify your local dev environment works before upgrading production.

**Step 1: Update all dependencies together**

```bash
# Install EmDash 0.37 + DashCommerce 0.2.x simultaneously
npm install emdash@^0.37.0 @emdash-cms/admin@^0.37.0 @dashcommerce/core@^0.2.0

# For Cloudflare deployments, also update:
npm install @emdash-cms/cloudflare@^0.37.0
```

**Step 2: Apply EmDash patch (required)**

DashCommerce requires [a small patch to EmDash](/packages/core/patches/emdash@0.37.0.patch) for webhook handling and response passthrough. The patch is shipped with `@dashcommerce/core@0.2.0` and documented in [`packages/core/patches/README.md`](/packages/core/patches/README.md).

```bash
# Using Bun (recommended) - add to package.json:
{
  "patchedDependencies": {
    "emdash@0.37.0": "node_modules/@dashcommerce/core/patches/emdash@0.37.0.patch"
  }
}

# Then reinstall:
bun install
```

See [`patches/README.md`](/packages/core/patches/README.md) for pnpm/npm/yarn instructions.

**Step 3: Update Astro config (if using Cloudflare Workers)**

EmDash 0.37 imports `cloudflare:*` runtime modules that must be externalized for Node.js builds:

```ts
// astro.config.mjs
export default defineConfig({
  // ... existing config
  vite: {
    build: {
      rollupOptions: {
        external: target === "node" ? [/^cloudflare:/] : [],
      },
    },
  },
});
```

**Step 4: Test checkout and webhooks**

1. Place a test order using Stripe test cards
2. Verify webhook signature verification works
3. Check that Stripe webhooks return HTTP 200 (not `{}`)
4. Test subscription creation/renewal if using subscriptions

**Step 5: Deploy to production**

After verifying everything works locally, deploy to your hosting environment and monitor for any compatibility warnings in logs.

### Stay on 0.1.x (no action required)

If you're not ready to upgrade to EmDash 0.37:

```bash
# Pin to the latest 0.1.x release
npm install @dashcommerce/core@^0.1.5

# Keep EmDash on 0.28.x
npm install emdash@^0.28.0 @emdash-cms/admin@^0.28.0
```

The 0.1.x line remains on npm and will continue working with EmDash 0.28.x. However, new features and non-security fixes will only land in 0.2.x+.

### Breaking Changes in 0.2.0

- **Minimum EmDash version**: Now `0.37.0` (was `0.28.0`)
- **Patch required**: Must apply `emdash@0.37.0` patch for webhooks to work
- **Node.js builds**: Must externalize `cloudflare:*` modules in Vite config
- **Runtime version check**: Plugin will throw on incompatible EmDash versions (fail-closed for safety)

See [CHANGELOG.md](/CHANGELOG.md) for full release notes.

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

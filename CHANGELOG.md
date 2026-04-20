# Changelog

All notable changes to dashcommerce will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

(nothing yet)

## [0.1.1] — 2026-04-19

### Added

- **`dashcommerce-merge-seed` CLI** (`@dashcommerce/core` `bin`): merges `defineProductsCollection()` + `defineProductTaxonomies()` into the host `seed.json` with deduplication by collection `slug` and taxonomy `name`. Resolves the seed path like `emdash seed` (`.emdash/seed.json` if present, else `package.json` → `emdash.seed`). Programmatic API: `mergeDashCommerceSeed()` exported from the package root.
- Recommended bootstrap: `dashcommerce-merge-seed && emdash seed` (after `emdash init` on a fresh database).

## [0.1.0] — 2026-04-19

First **npm** release of `@dashcommerce/core` under semantic versioning `0.1.0`. The plugin descriptor version (`DASHCOMMERCE_VERSION`) matches the package.

### Highlights

- **Commerce engine (MIT):** products (all major types), multi-currency, cart + coupons + shipping + tax (flat / table / Stripe Tax), Stripe **hosted** and **embedded** checkout, orders + refunds, customers, inventory soft-locks, reviews, digital downloads, Stripe Subscriptions + dunning, Stripe Connect + vendor lifecycle, abandoned-cart recovery, transactional email (HTML + plain text), admin reports.
- **Native plugin:** React admin (12 pages, 5 widgets), Portable Text blocks, field widgets; runtime remains sandbox-safe (`@dashcommerce/core/sandbox`).
- **Starter:** `@dashcommerce/starter@0.1.0` — reference Astro storefront (`packages/starter`).

### Notes

- **`0.x`:** treat minors as potentially breaking until **1.0.0**; pin `^0.1.0` carefully in production.
- **Marketing / docs:** https://dashcommerce.dev — **live demo:** https://demo.dashcommerce.dev

## Earlier history (pre-npm)

### Added

**Phases 1–5 of the v1.0 plan:**

- **Phase 1 — Scaffold:** bun workspace, `@dashcommerce/core` package with `.`, `./sandbox`, `./admin`, `./astro` exports, `tsdown` build, CI workflow, MIT license, root README.
- **Phase 2 — Foundations:** `Money` type (ISO 4217, integer minor units, zero- and three-decimal awareness, currency-safe arithmetic); full entity type surface (Product, Variant, Cart, Order, Refund, Customer, Coupon, ShippingZone/Method/Class, TaxRate, Subscription, Review, Vendor, DownloadGrant, InventoryLedgerEntry, StockLock); `defineProductsCollection()` helper for hosts; 19 plugin storage collections declared with indexes + unique indexes.
- **Phase 3 — Products:** content `beforeSave` validation for commerce fields, product type predicates (purchasability, shipping), variant CRUD against plugin storage, price resolver (variant override, currency-scoped).
- **Phase 4 — Cart:** KV-backed cart store (session cookie), pure currency-aware totals pipeline, coupon validator + discount resolver for all 5 discount types, shipping rate calculator for flat/free/pickup/weight-based methods, tax table engine with compound support, public cart routes.
- **Phase 5 — Stripe primitives:** sandbox-safe Stripe client (`ctx.http.fetch`, urlencoded bodies, `Idempotency-Key`, Connect `Stripe-Account` header), PaymentIntent create/retrieve, webhook signature verification via `crypto.subtle` (HMAC-SHA256, constant-time compare, tolerance window).

**Resume kit:**

- `RESUME.md` with full status + invariants.
- `.claude/skills/dashcommerce-continuation/` with SKILL.md and per-phase reference files covering phases 6–19.

### Completed (merged into 0.1.0 story)

Phases 6–19 of the approved plan shipped in-tree before the **0.1.0** tag: checkout, orders, refunds, subscriptions, downloads, reviews, Connect, abandoned cart, admin UI, storefront islands, Portable Text, transactional emails, reports, install hook, tests, starter.

# Changelog — @dashcommerce/core

## 0.1.5

### Patch Changes

- [#16](https://github.com/emdashCommerce/dashcommerce/pull/16) [`b865dd7`](https://github.com/emdashCommerce/dashcommerce/commit/b865dd78bfb2b4d6805c7aa9526d85819da7a5ee) Thanks [@cavewebs](https://github.com/cavewebs)! - Support EmDash 0.28.

  Migrate from emdash 0.6 to 0.28.1. The plugin now builds its native
  `ResolvedPlugin` via `definePlugin` with single-argument `RouteContext`
  handlers (emdash's native route shape) instead of `adaptSandboxEntry`, whose
  0.28 form flattens the request and would break the Stripe webhook's raw-body
  signature check. Capability names are updated to the current vocabulary
  (`network:request`, `content:read`, `content:write`, `media:read`,
  `users:read`), and the emdash peer range is now `>=0.28.0 <0.29.0`.

  The bundled emdash patch is re-authored for 0.28.1: plugin route handlers may
  still return a raw `Response` (cookies, redirects, webhook 200s), and the raw
  request body is preserved so `ctx.request.text()` works for Stripe webhook
  signature verification.

  The starter adds a Cloudflare Worker entry (`src/worker.ts`) plus a Cron
  Trigger so plugin cron — abandoned-cart recovery, subscription dunning, and
  stock-lock sweeps — runs on Workers (emdash 0.19+ drives cron from a
  `scheduled()` handler, not request side effects).

## 0.1.4

### Patch Changes

- [#12](https://github.com/emdashCommerce/dashcommerce/pull/12) [`321e810`](https://github.com/emdashCommerce/dashcommerce/commit/321e810383dc784f9e8f0512dba55a309eae3336) Thanks [@cavewebs](https://github.com/cavewebs)! - Upgrade to emdash 0.6.0.

  - `@dashcommerce/core`: widen `emdash` peer range to `>=0.5.0 <0.7.0`. Bump the bundled devDeps (`emdash`, `@emdash-cms/admin`) to `^0.6.0` so the package builds against current types. No public API changes.
  - `@dashcommerce/starter`: bump `emdash` and `@emdash-cms/cloudflare` to `^0.6.0`. 0.6's [release fix for `syncSearchState` FTS-during-field-creation](https://github.com/emdash-cms/emdash/pull/595) eliminates the partial-DDL issue that was truncating collection schemas on Cloudflare D1 setup and throwing mid-seed on Postgres. Storefront surfaced zero typecheck errors on the upgrade — no porting required.

  Stripe webhook body-clone patch regenerated for 0.6 (`patches/emdash@0.6.0.patch`) since the upstream `request.clone().json()` fix still isn't in place.

All notable changes to this package are documented here and in the [monorepo CHANGELOG.md](../../CHANGELOG.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-04-20

- Widened `emdash` peer range to `>=0.4.0 <0.6.0` — consumers on emdash 0.5 (needed for the Cloudflare D1/R2 adapters in `@emdash-cms/cloudflare`) are supported alongside existing 0.4 installs.

## [0.1.2] — 2026-04-20

- **`dashcommerce-merge-seed --with-demo-catalog`**: append 6 demo products (one per product type) + curated `product_category` / `product_tag` terms. Idempotent by product `id`.
- `mergeDashCommerceSeed(seed, { withDemoCatalog })` programmatic API mirrors the flag.
- New exports: `DEMO_PRODUCTS`, `DEMO_PRODUCT_CATEGORY_TERMS`, `DEMO_PRODUCT_TAG_TERMS`, `DemoProductEntry`, `DemoTaxonomyTerm`.
- Fixed admin Settings page crash when `_secrets` is not yet populated on a fresh install.
- Fixed admin Reports page crash when no paid orders exist in the selected range.
- Build: registered `node:*` as explicit externals so the Node-only CLI entry no longer warns under `platform: "neutral"`.
- See monorepo **CHANGELOG.md** for details.

## [0.1.1] — 2026-04-19

- **`dashcommerce-merge-seed`**: CLI binary merges `products` collection + product taxonomies into the host `seed.json` (dedupe by slug / name). Export `mergeDashCommerceSeed()` for programmatic use.
- See monorepo **CHANGELOG.md** for details.

## [0.1.0] — 2026-04-19

- Initial public npm release. See monorepo **CHANGELOG.md** for full feature list.
- `DASHCOMMERCE_VERSION` in `src/index.ts` matches this package version.

## [0.0.8] and earlier

- Internal / pre-publish builds; see git history.

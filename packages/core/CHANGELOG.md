# Changelog — @dashcommerce/core

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

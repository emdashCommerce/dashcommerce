---
"@dashcommerce/core": patch
"@dashcommerce/starter": minor
---

Upgrade to emdash 0.6.0.

- `@dashcommerce/core`: widen `emdash` peer range to `>=0.5.0 <0.7.0`. Bump the bundled devDeps (`emdash`, `@emdash-cms/admin`) to `^0.6.0` so the package builds against current types. No public API changes.
- `@dashcommerce/starter`: bump `emdash` and `@emdash-cms/cloudflare` to `^0.6.0`. 0.6's [release fix for `syncSearchState` FTS-during-field-creation](https://github.com/emdash-cms/emdash/pull/595) eliminates the partial-DDL issue that was truncating collection schemas on Cloudflare D1 setup and throwing mid-seed on Postgres. Storefront surfaced zero typecheck errors on the upgrade — no porting required.

Stripe webhook body-clone patch regenerated for 0.6 (`patches/emdash@0.6.0.patch`) since the upstream `request.clone().json()` fix still isn't in place.

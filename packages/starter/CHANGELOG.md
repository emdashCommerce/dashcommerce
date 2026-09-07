# @dashcommerce/starter

## 0.3.1

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

- Updated dependencies [[`b865dd7`](https://github.com/emdashCommerce/dashcommerce/commit/b865dd78bfb2b4d6805c7aa9526d85819da7a5ee)]:
  - @dashcommerce/core@0.1.5

## 0.3.0

### Minor Changes

- [#12](https://github.com/emdashCommerce/dashcommerce/pull/12) [`321e810`](https://github.com/emdashCommerce/dashcommerce/commit/321e810383dc784f9e8f0512dba55a309eae3336) Thanks [@cavewebs](https://github.com/cavewebs)! - Upgrade to emdash 0.6.0.

  - `@dashcommerce/core`: widen `emdash` peer range to `>=0.5.0 <0.7.0`. Bump the bundled devDeps (`emdash`, `@emdash-cms/admin`) to `^0.6.0` so the package builds against current types. No public API changes.
  - `@dashcommerce/starter`: bump `emdash` and `@emdash-cms/cloudflare` to `^0.6.0`. 0.6's [release fix for `syncSearchState` FTS-during-field-creation](https://github.com/emdash-cms/emdash/pull/595) eliminates the partial-DDL issue that was truncating collection schemas on Cloudflare D1 setup and throwing mid-seed on Postgres. Storefront surfaced zero typecheck errors on the upgrade — no porting required.

  Stripe webhook body-clone patch regenerated for 0.6 (`patches/emdash@0.6.0.patch`) since the upstream `request.clone().json()` fix still isn't in place.

### Patch Changes

- Updated dependencies [[`321e810`](https://github.com/emdashCommerce/dashcommerce/commit/321e810383dc784f9e8f0512dba55a309eae3336)]:
  - @dashcommerce/core@0.1.4

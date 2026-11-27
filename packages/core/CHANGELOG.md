# Changelog — @dashcommerce/core

## 0.4.0

### Minor Changes

- [#83](https://github.com/emdashCommerce/dashcommerce/pull/83) [`b183450`](https://github.com/emdashCommerce/dashcommerce/commit/b183450d963a4daafc0377034772942321135b54) Thanks [@moset15](https://github.com/moset15)! - Checkout follows the active payment provider instead of assuming Stripe.

  - New provider flag `collectsCustomerDetails` (Stripe sets it). For providers whose page collects neither email nor address, `create-session` answers 409 `customer_details_required` until the cart has them, and `HostedCheckoutForm` asks for email, name, phone and address (country only for digital carts), saved through `cart/contact`.
  - `HostedCheckoutForm` names the provider on its button and shows readable errors when a route crashes (EmDash wraps those as `{ error: { code, message } }`), which used to show `[object Object]` for Stripe too.
  - `config-check` reports `paymentProvider`.
  - Starter: checks the active provider's keys, and the cart and announcement copy no longer name Stripe.

  Stripe stores see no change.

- [#82](https://github.com/emdashCommerce/dashcommerce/pull/82) [`35d1319`](https://github.com/emdashCommerce/dashcommerce/commit/35d13194351b1c62dba751e120f2991669c6dfe5) Thanks [@moset15](https://github.com/moset15)! - A refund that fails at the payment provider no longer counts against its order.

  - When a provider reports a pending refund as failed (`refund.updated`), core takes its amount back off the order's refunded total, works out the payment and order status again, and takes back any stock the refund put back. With no refund left counting, the order returns to the status it had before its first refund (refunds now record it as `orderStatusBefore`). Stock that has been sold again is not taken back; that is logged.
  - A refund the provider fails straight away is recorded as failed and changes nothing on the order: no totals, no restock, no refund email.
  - The failed refund stays on the order, marked failed, and is logged as an error.
  - New inventory ledger reason `refund_failed`.

- [#84](https://github.com/emdashCommerce/dashcommerce/pull/84) [`3e6be0e`](https://github.com/emdashCommerce/dashcommerce/commit/3e6be0e239aba720879ff036bd58501ee6762b5a) Thanks [@moset15](https://github.com/moset15)! - On-page ("embedded") checkout for any provider that offers it, not only Stripe.

  - Providers declare `checkoutStyles` (`hosted`, `on_page`); `initCheckout` receives `checkoutStyle` and may return an `on_page` result with `client` data for the provider's browser client. Stripe declares both, and its Elements flow is unchanged.
  - With `checkoutMode` embedded, `create-session` returns `{ kind: "on_page", client, returnUrl }` for a provider that supports it, and a 409 naming the provider for one that doesn't. Redirect results gain `kind: "redirect"`.
  - `HostedCheckoutForm` opens the provider's client from `window.DashCommerceCheckoutClients` (`OnPageCheckoutClient`). Its callbacks only move the customer; the order is still created only from the signed webhook.
  - Settings offers "How customers pay" (hosted or on your page) for a provider that supports both.

- [#81](https://github.com/emdashCommerce/dashcommerce/pull/81) [`1ab91de`](https://github.com/emdashCommerce/dashcommerce/commit/1ab91def69feb2709d6a0933bffeffe635ef2496) Thanks [@moset15](https://github.com/moset15)! - Make non-Stripe payment providers usable on a live site.

  - `dashcommerce({ allowedHosts })` adds a provider's API hosts to Stripe's. Without it the hosts are unchanged.
  - The settings API saves `<id>SecretKey` and `<id>WebhookSecret` for registered providers, validated against the prefixes a provider declares in `credentialFields` and masked like Stripe's. `GET admin/settings` lists registered providers under `_providers`. Settings shows a Payment provider card with a picker when a provider other than Stripe is registered.
  - A provider can declare `checkConnection`, a read-only check of its saved keys. Settings then shows a "Test connection" button for it, like Stripe's.
  - `verifyWebhook` receives every request header and the provider's saved credentials (for headers signed with the API key rather than the webhook secret), and a provider can declare `webhookHeaders` for routing. `stripe-signature` stays reserved for Stripe.
  - A new normalised event, `refund.updated`, moves a provider's pending refund to `succeeded` or `failed`.
  - A webhook retry is now processed when the first delivery failed only because the payment could not be confirmed with the provider (`getPaymentStatus`, or Stripe's PaymentIntent retrieve on `checkout.session.completed`). Before, it was answered as a duplicate and the order was never created. Other handler failures still keep the retry deduplicated.

### Patch Changes

- [#80](https://github.com/emdashCommerce/dashcommerce/pull/80) [`37ab841`](https://github.com/emdashCommerce/dashcommerce/commit/37ab841b29160be5a08a61e3d25e5a109e87603b) Thanks [@moset15](https://github.com/moset15)! - Make the admin readable in EmDash's dark mode ([#44](https://github.com/emdashCommerce/dashcommerce/issues/44)). Admin pages, fields and widgets now take their colours from EmDash's theme tokens, so they follow the host's light or dark mode. Light fallbacks cover hosts without those tokens, and the existing `--dc-*` variables still override. Status badge colours are unchanged.

- [#90](https://github.com/emdashCommerce/dashcommerce/pull/90) [`014afff`](https://github.com/emdashCommerce/dashcommerce/commit/014afff43cb36c3fa7eadeb77e14008b2030326d) Thanks [@cavewebs](https://github.com/cavewebs)! - Support EmDash 1.6.0. Ship `patches/emdash@1.6.0.patch` (same raw Response passthrough and request body clone fix as 1.5.0, retargeted at 1.6.0's hashed dist files `routes-BScyES_G.mjs` and `http-route-dispatch-Y8bwyixm.mjs`). Widen the EmDash peer range to `>=0.37.0 <0.38.0 || >=1.1.0 <1.7.0` so create-emdash 1.6 installs pass peer checks. Cap below 1.7 so the next untested EmDash minor is still rejected. Point the starter at `emdash` / `@emdash-cms/cloudflare` ^1.6.0 and refresh its migrations snapshot through `098_user_last_login`.

- [#77](https://github.com/emdashCommerce/dashcommerce/pull/77) [`d134af0`](https://github.com/emdashCommerce/dashcommerce/commit/d134af02478a3b56ecdab7cfcabae8254bbff548) Thanks [@moset15](https://github.com/moset15)! - Only offer shipping methods priced in the cart's currency. A flat-rate or local-pickup method in another currency (or a free-shipping threshold set in another currency) used to be offered, and choosing it failed with a 500 (`CurrencyMismatchError`). It is now left out, like weight-based methods already were.

## 0.3.6

### Patch Changes

- [#87](https://github.com/emdashCommerce/dashcommerce/pull/87) [`635d3eb`](https://github.com/emdashCommerce/dashcommerce/commit/635d3ebc46cb3260938cd1911dd8154fa4a759aa) Thanks [@cavewebs](https://github.com/cavewebs)! - Republish of 0.3.5 from a clean build. 0.3.5 shipped a stale runtime version check that rejected EmDash 1.4 and 1.5, and lost the dashcommerce-merge-seed command. 0.3.6 supports EmDash up to 1.5 (peer <1.6.0) with the 1.5.0 patch.

## 0.3.5

### Patch Changes

- [#70](https://github.com/emdashCommerce/dashcommerce/pull/70) [`00d81ad`](https://github.com/emdashCommerce/dashcommerce/commit/00d81add96f0a643b47396eba9dfc8134f46bfbe) Thanks [@cavewebs](https://github.com/cavewebs)! - Support EmDash 1.5.0. Ship `patches/emdash@1.5.0.patch` (same raw Response passthrough and request body clone fix as 1.4.0, retargeted at 1.5.0's hashed dist files `routes-QcHRiebw.mjs` and `http-route-dispatch-BsjkWBZF.mjs`). Widen the EmDash peer range to `>=0.37.0 <0.38.0 || >=1.1.0 <1.6.0` so create-emdash 1.5 installs pass peer checks. Cap below 1.6 so the next untested EmDash minor is still rejected. Point the starter at `emdash` / `@emdash-cms/cloudflare` ^1.5.0, refresh its migrations snapshot, and type PortableText `value` for 1.5.0's stricter `emdash/ui` props.

- [#69](https://github.com/emdashCommerce/dashcommerce/pull/69) [`2577cbf`](https://github.com/emdashCommerce/dashcommerce/commit/2577cbf531cd81f551921a4bce6dcb6323d01fd9) Thanks [@robertmonroe](https://github.com/robertmonroe)! - Stop `GET /orders/by-draft` from returning the full stored order ([#68](https://github.com/emdashCommerce/dashcommerce/issues/68)). The route is public and its draft id travels in the thank-you URL, so the `ready` response now carries only what the thank-you page renders: order id, number, status, currency, total, a masked customer email, and each item's id, name, quantity and total. Addresses, Stripe ids, IP address, user agent, coupon codes, notes, metadata and vendor data are no longer exposed. The receipt line on the thank-you page now shows the masked email (`j***@example.com`).

- [#72](https://github.com/emdashCommerce/dashcommerce/pull/72) [`f94864a`](https://github.com/emdashCommerce/dashcommerce/commit/f94864ab690680c14a37602a07960e0e96751b5a) Thanks [@cavewebs](https://github.com/cavewebs)! - Stop public review and subscription routes from returning stored records. `GET /reviews/list` and `GET /reviews/item` now return an allowlisted shape (id, rating, title, body, display name, createdAt, verifiedPurchase) so customer email, customerId and moderation metadata never reach the storefront. `GET /subscriptions/state` returns only the portal island fields (status, amount, interval, period end, cancel-at-period-end) and no longer includes stripeSubscriptionId or customerId. Cancel/pause/resume still run; they echo Stripe status, not Stripe ids.

## 0.3.4

### Patch Changes

- [#65](https://github.com/emdashCommerce/dashcommerce/pull/65) [`32f4f57`](https://github.com/emdashCommerce/dashcommerce/commit/32f4f577535c7216b9e173066ee22058a671bea4) - Republish with a fresh build so the shipped dist matches main (EmDash peer `<1.5.0` / runtime version-check). npm 0.3.3 incorrectly shipped the 0.3.2 dist. See [#63](https://github.com/emdashCommerce/dashcommerce/issues/63).

## 0.3.3

### Patch Changes

- [#60](https://github.com/emdashCommerce/dashcommerce/pull/60) [`37b9afc`](https://github.com/emdashCommerce/dashcommerce/commit/37b9afcba62db4d34fb40660c954721d13fc7166) Thanks [@cavewebs](https://github.com/cavewebs)! - Support EmDash 1.4.0. Ship `patches/emdash@1.4.0.patch` (same raw Response passthrough and request body clone fix as 1.3.1, retargeted at 1.4.0's hashed dist files). Widen the EmDash peer range to `>=0.37.0 <0.38.0 || >=1.1.0 <1.5.0` so create-emdash 1.4 installs pass peer checks. Cap below 1.5 so the next untested EmDash minor is still rejected.

## 0.3.2

### Patch Changes

- [#47](https://github.com/emdashCommerce/dashcommerce/pull/47) [`cbd16cb`](https://github.com/emdashCommerce/dashcommerce/commit/cbd16cb3e48949340a49d14da2c65abc250fa975) Thanks [@cavewebs](https://github.com/cavewebs)! - Support EmDash 1.3.0 and 1.3.1. Ship `patches/emdash@1.3.0.patch` and `patches/emdash@1.3.1.patch` (same raw Response passthrough and request body clone fix as 1.2.0, retargeted at each release's hashed dist files). Cap the EmDash peer range at `>=0.37.0 <0.38.0 || >=1.1.0 <1.4.0` so untested EmDash releases are rejected instead of silently dropping Set-Cookie and breaking webhooks.

  Fix EmDash version detection so the compatibility check actually runs. `dashcommerce()` now detects the installed EmDash version and passes it to the plugin. If that version is in range but has no shipped patch (for example 1.3.2), DashCommerce prints a loud warning in the dev/build terminal and again at plugin init. Versions outside the supported range now fail at plugin init, as the check intended.

## 0.3.1

### Patch Changes

- [#45](https://github.com/emdashCommerce/dashcommerce/pull/45) [`7a156cb`](https://github.com/emdashCommerce/dashcommerce/commit/7a156cb3f7729bb85f676a9653ea6dc350f08e4f) Thanks [@cavewebs](https://github.com/cavewebs)! - Match checkout sidebar radios to `methodId` from `cart/shipping-methods`, and broadcast shipping-method cart updates as silent so the cart drawer does not cover checkout.

- [#45](https://github.com/emdashCommerce/dashcommerce/pull/45) [`4b1f2a1`](https://github.com/emdashCommerce/dashcommerce/commit/4b1f2a1fe967df89cdd90259ff03dd92d903bdfc) Thanks [@cavewebs](https://github.com/cavewebs)! - Preserve raw Web `Response` objects on EmDash 1.2 (cart `Set-Cookie`, Stripe webhook bodies) without defaulting `response: "raw"`, which fails typecheck on 0.37 and strips cookies on unpatched 1.x. Ship a version-exact 1.2.0 patch that clones the request body and duck-types `Response`, warn when the host version has no matching patch, and fail loudly if a webhook arrives with the body already consumed.

  Thanks [@moset15](https://github.com/moset15) for the original routing fix in [#42](https://github.com/emdashCommerce/dashcommerce/issues/42).

- [#45](https://github.com/emdashCommerce/dashcommerce/pull/45) [`12fd4e5`](https://github.com/emdashCommerce/dashcommerce/commit/12fd4e5d4f03f9329ec4d6dc46b709f738d235aa) Thanks [@cavewebs](https://github.com/cavewebs)! - Stop the shipping admin page from crashing when `data.methods` (or zones/classes) is missing. A flattened EmDash success envelope used to throw `can't access property Symbol.iterator, data.methods is undefined`. Empty lists render instead.

  Closes [#43](https://github.com/emdashCommerce/dashcommerce/issues/43).

## 0.3.0

### Minor Changes

- [#40](https://github.com/emdashCommerce/dashcommerce/pull/40) [`67c3c34`](https://github.com/emdashCommerce/dashcommerce/commit/67c3c3443d1fdb8890359137030cce17b5bebcfa) Thanks [@cavewebs](https://github.com/cavewebs)! - Add a gateway-agnostic PaymentProvider seam (`@dashcommerce/core/payment-provider`) with a Stripe adapter and test mock, so additional processors can plug into hosted checkout, webhook verification, and refunds without forking core.

  Hosted `checkout/create-session`, `checkout/webhook`, and admin refunds now go through `resolveProvider()` (default `"stripe"`). Checkout session ids and PaymentIntent ids are separate (`checkoutReference` / `paymentReference`); webhook dedupe uses `providerEventId` (Stripe `event.id`); refunds require an explicit `refundRequestId`; duplicate provider registration throws unless `override: true` is passed.

  Refunds load credentials by `order.providerId` (no silent Stripe fallback, admin no longer requires a Stripe key). Webhooks route by signature header so in-flight Stripe events still verify after a provider switch. Captured amount **and** currency are reconciled (hold/withhold on mismatch); non-Stripe hosted checkout 409s coupons/Connect/subs unless the adapter declares support.

  Thanks [@moset15](https://github.com/moset15) / FIKANOVA for the original PaymentProvider design in [#18](https://github.com/emdashCommerce/dashcommerce/issues/18).

## 0.2.2

### Patch Changes

- [#36](https://github.com/emdashCommerce/dashcommerce/pull/36) [`2b462ee`](https://github.com/emdashCommerce/dashcommerce/commit/2b462ee05cd09a1a94968fbd4589795aded8a8e9) Thanks [@cavewebs](https://github.com/cavewebs)! - Widen the `emdash` peer to `>=0.37.0 <0.38.0 || >=1.1.0 <2.0.0` so current EmDash 1.x installs pass peer checks without bricking 0.37.x. The runtime compatibility check matches that range (skipping untested 0.38–0.42 and the mistaken `emdash@1.0.0` publish). Dual-version patches keep Stripe webhook raw-body reads and raw `Response` passthrough working on both 0.37.0 and 1.1.0.

## 0.2.1

### Patch Changes

- [#34](https://github.com/emdashCommerce/dashcommerce/pull/34) [`55ca9fa`](https://github.com/emdashCommerce/dashcommerce/commit/55ca9fa5408619f717c92ff020e59ce04a49a4cd) Thanks [@cavewebs](https://github.com/cavewebs)! - Harden checkout and Stripe webhook payment integrity: verify variant ownership, re-resolve coupon/shipping amounts at checkout, require paid payment status (incl. async success), and reconcile PaymentIntent amounts; fix hosted Checkout Session tax/discount line items.

- [#26](https://github.com/emdashCommerce/dashcommerce/pull/26) [`bcdad21`](https://github.com/emdashCommerce/dashcommerce/commit/bcdad21b6519442c5f62bdf6b5382179f69d5570) Thanks [@cavewebs](https://github.com/cavewebs)! - Railway/reverse-proxy: use configured public site URL for Stripe success/cancel and portal return URLs instead of request.origin which can be localhost:PORT

## 0.2.0

### Minor Changes

- [#23](https://github.com/emdashCommerce/dashcommerce/pull/23) [`ef8360b`](https://github.com/emdashCommerce/dashcommerce/commit/ef8360be32b6f99fd07cc3b0a47cb913c96e724c) Thanks [@cavewebs](https://github.com/cavewebs)! - Upgrade to EmDash 0.37.0 with comprehensive auto-update safety system.

  **Breaking Change**: Minimum EmDash version is now `0.37.0` (peer dependency updated from `>=0.28.0 <0.29.0` to `>=0.37.0 <0.38.0`). This is a breaking change for consumers on EmDash 0.28-0.36.

  **EmDash 0.37 Upgrade**:

  - All EmDash dependencies upgraded from 0.28.x to 0.37.0 across the monorepo
  - Ported EmDash patch for request.clone().json() and Response passthrough to 0.37.0 structure
  - Fixed Node.js build by externalizing Cloudflare Workers runtime modules (`cloudflare:sockets`, etc.) that EmDash 0.37 imports conditionally

  **Auto-Update Safety System** (prevents silent breakage on future EmDash updates):

  1. **Runtime Compatibility Check**: New `version-check.ts` module validates EmDash version at plugin initialization, providing clear error messages when version is incompatible
  2. **Renovate Configuration**: Auto-merges EmDash patch/minor updates when CI passes; requires manual review for major versions
  3. **CI Compatibility Matrix**: Tests DashCommerce against all supported EmDash versions in parallel

  **Supported EmDash Range**: This release supports `0.37.0 <= version < 0.38.0`. Future EmDash updates will be gated by CI and runtime compatibility checks.

  All typechecks, builds, and tests pass on EmDash 0.37.0.

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

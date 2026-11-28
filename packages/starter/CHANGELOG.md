# @dashcommerce/starter

## 0.3.13

### Patch Changes

- Updated dependencies [[`05f9d34`](https://github.com/emdashCommerce/dashcommerce/commit/05f9d34b55e8b8b33f6534202365a6100c5671a2), [`07f19e7`](https://github.com/emdashCommerce/dashcommerce/commit/07f19e7667a23f86e64ba51cd5b3f1dcf703aede), [`6f81f05`](https://github.com/emdashCommerce/dashcommerce/commit/6f81f05756a5dc97710b4dfc071a09925a4bc481), [`422fc82`](https://github.com/emdashCommerce/dashcommerce/commit/422fc821ff59adf8de5f6eb5da534d489d47950a), [`016dc31`](https://github.com/emdashCommerce/dashcommerce/commit/016dc31f571768086aa4e5978219a182a6155cc6)]:
  - @dashcommerce/core@0.5.0

## 0.3.12

### Patch Changes

- [#78](https://github.com/emdashCommerce/dashcommerce/pull/78) [`d3ea912`](https://github.com/emdashCommerce/dashcommerce/commit/d3ea912fe876832a9f71a217851e7718500a3576) Thanks [@moset15](https://github.com/moset15)! - Keep the cart drawer closed when the customer continues to payment on `/checkout`. Saving their details now sends a silent cart update, like the rest of checkout does, so the drawer no longer slides open over the payment form.

- [#83](https://github.com/emdashCommerce/dashcommerce/pull/83) [`b183450`](https://github.com/emdashCommerce/dashcommerce/commit/b183450d963a4daafc0377034772942321135b54) Thanks [@moset15](https://github.com/moset15)! - Checkout follows the active payment provider instead of assuming Stripe.

  - New provider flag `collectsCustomerDetails` (Stripe sets it). For providers whose page collects neither email nor address, `create-session` answers 409 `customer_details_required` until the cart has them, and `HostedCheckoutForm` asks for email, name, phone and address (country only for digital carts), saved through `cart/contact`.
  - `HostedCheckoutForm` names the provider on its button and shows readable errors when a route crashes (EmDash wraps those as `{ error: { code, message } }`), which used to show `[object Object]` for Stripe too.
  - `config-check` reports `paymentProvider`.
  - Starter: checks the active provider's keys, and the cart and announcement copy no longer name Stripe.

  Stripe stores see no change.

- [#90](https://github.com/emdashCommerce/dashcommerce/pull/90) [`014afff`](https://github.com/emdashCommerce/dashcommerce/commit/014afff43cb36c3fa7eadeb77e14008b2030326d) Thanks [@cavewebs](https://github.com/cavewebs)! - Support EmDash 1.6.0. Ship `patches/emdash@1.6.0.patch` (same raw Response passthrough and request body clone fix as 1.5.0, retargeted at 1.6.0's hashed dist files `routes-BScyES_G.mjs` and `http-route-dispatch-Y8bwyixm.mjs`). Widen the EmDash peer range to `>=0.37.0 <0.38.0 || >=1.1.0 <1.7.0` so create-emdash 1.6 installs pass peer checks. Cap below 1.7 so the next untested EmDash minor is still rejected. Point the starter at `emdash` / `@emdash-cms/cloudflare` ^1.6.0 and refresh its migrations snapshot through `098_user_last_login`.

- [#84](https://github.com/emdashCommerce/dashcommerce/pull/84) [`3e6be0e`](https://github.com/emdashCommerce/dashcommerce/commit/3e6be0e239aba720879ff036bd58501ee6762b5a) Thanks [@moset15](https://github.com/moset15)! - On-page ("embedded") checkout for any provider that offers it, not only Stripe.

  - Providers declare `checkoutStyles` (`hosted`, `on_page`); `initCheckout` receives `checkoutStyle` and may return an `on_page` result with `client` data for the provider's browser client. Stripe declares both, and its Elements flow is unchanged.
  - With `checkoutMode` embedded, `create-session` returns `{ kind: "on_page", client, returnUrl }` for a provider that supports it, and a 409 naming the provider for one that doesn't. Redirect results gain `kind: "redirect"`.
  - `HostedCheckoutForm` opens the provider's client from `window.DashCommerceCheckoutClients` (`OnPageCheckoutClient`). Its callbacks only move the customer; the order is still created only from the signed webhook.
  - Settings offers "How customers pay" (hosted or on your page) for a provider that supports both.

- [#79](https://github.com/emdashCommerce/dashcommerce/pull/79) [`c268d2a`](https://github.com/emdashCommerce/dashcommerce/commit/c268d2a8ac4090a89a079a38ff0f521d230841d5) Thanks [@moset15](https://github.com/moset15)! - Pre-bundle the Stripe packages in dev, so the first visit to `/checkout` no longer makes Vite re-optimise and reload. That reload left open admin tabs with two copies of React and an "Invalid hook call" crash.

- Updated dependencies [[`37ab841`](https://github.com/emdashCommerce/dashcommerce/commit/37ab841b29160be5a08a61e3d25e5a109e87603b), [`b183450`](https://github.com/emdashCommerce/dashcommerce/commit/b183450d963a4daafc0377034772942321135b54), [`014afff`](https://github.com/emdashCommerce/dashcommerce/commit/014afff43cb36c3fa7eadeb77e14008b2030326d), [`35d1319`](https://github.com/emdashCommerce/dashcommerce/commit/35d13194351b1c62dba751e120f2991669c6dfe5), [`3e6be0e`](https://github.com/emdashCommerce/dashcommerce/commit/3e6be0e239aba720879ff036bd58501ee6762b5a), [`1ab91de`](https://github.com/emdashCommerce/dashcommerce/commit/1ab91def69feb2709d6a0933bffeffe635ef2496), [`d134af0`](https://github.com/emdashCommerce/dashcommerce/commit/d134af02478a3b56ecdab7cfcabae8254bbff548)]:
  - @dashcommerce/core@0.4.0

## 0.3.11

### Patch Changes

- Updated dependencies [[`635d3eb`](https://github.com/emdashCommerce/dashcommerce/commit/635d3ebc46cb3260938cd1911dd8154fa4a759aa)]:
  - @dashcommerce/core@0.3.6

## 0.3.10

### Patch Changes

- [#70](https://github.com/emdashCommerce/dashcommerce/pull/70) [`00d81ad`](https://github.com/emdashCommerce/dashcommerce/commit/00d81add96f0a643b47396eba9dfc8134f46bfbe) Thanks [@cavewebs](https://github.com/cavewebs)! - Support EmDash 1.5.0. Ship `patches/emdash@1.5.0.patch` (same raw Response passthrough and request body clone fix as 1.4.0, retargeted at 1.5.0's hashed dist files `routes-QcHRiebw.mjs` and `http-route-dispatch-BsjkWBZF.mjs`). Widen the EmDash peer range to `>=0.37.0 <0.38.0 || >=1.1.0 <1.6.0` so create-emdash 1.5 installs pass peer checks. Cap below 1.6 so the next untested EmDash minor is still rejected. Point the starter at `emdash` / `@emdash-cms/cloudflare` ^1.5.0, refresh its migrations snapshot, and type PortableText `value` for 1.5.0's stricter `emdash/ui` props.

- Updated dependencies [[`00d81ad`](https://github.com/emdashCommerce/dashcommerce/commit/00d81add96f0a643b47396eba9dfc8134f46bfbe), [`2577cbf`](https://github.com/emdashCommerce/dashcommerce/commit/2577cbf531cd81f551921a4bce6dcb6323d01fd9), [`f94864a`](https://github.com/emdashCommerce/dashcommerce/commit/f94864ab690680c14a37602a07960e0e96751b5a)]:
  - @dashcommerce/core@0.3.5

## 0.3.9

### Patch Changes

- Updated dependencies [[`32f4f57`](https://github.com/emdashCommerce/dashcommerce/commit/32f4f577535c7216b9e173066ee22058a671bea4)]:
  - @dashcommerce/core@0.3.4

## 0.3.8

### Patch Changes

- Updated dependencies [[`37b9afc`](https://github.com/emdashCommerce/dashcommerce/commit/37b9afcba62db4d34fb40660c954721d13fc7166)]:
  - @dashcommerce/core@0.3.3

## 0.3.7

### Patch Changes

- [#53](https://github.com/emdashCommerce/dashcommerce/pull/53) [`ff67d95`](https://github.com/emdashCommerce/dashcommerce/commit/ff67d95ea475abd35cfb2d96f47adfddd92fcbb0) Thanks [@cavewebs](https://github.com/cavewebs)! - Require EmDash 1.3.1 (`emdash` and `@emdash-cms/cloudflare` ^1.3.1) and document the commented `worker_loaders` binding that sandboxed plugins such as DashCommerce Lite need on Cloudflare (Workers Paid).

## 0.3.6

### Patch Changes

- Updated dependencies [[`cbd16cb`](https://github.com/emdashCommerce/dashcommerce/commit/cbd16cb3e48949340a49d14da2c65abc250fa975)]:
  - @dashcommerce/core@0.3.2

## 0.3.5

### Patch Changes

- Updated dependencies [[`7a156cb`](https://github.com/emdashCommerce/dashcommerce/commit/7a156cb3f7729bb85f676a9653ea6dc350f08e4f), [`4b1f2a1`](https://github.com/emdashCommerce/dashcommerce/commit/4b1f2a1fe967df89cdd90259ff03dd92d903bdfc), [`12fd4e5`](https://github.com/emdashCommerce/dashcommerce/commit/12fd4e5d4f03f9329ec4d6dc46b709f738d235aa)]:
  - @dashcommerce/core@0.3.1

## 0.3.4

### Patch Changes

- Updated dependencies [[`67c3c34`](https://github.com/emdashCommerce/dashcommerce/commit/67c3c3443d1fdb8890359137030cce17b5bebcfa)]:
  - @dashcommerce/core@0.3.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`2b462ee`](https://github.com/emdashCommerce/dashcommerce/commit/2b462ee05cd09a1a94968fbd4589795aded8a8e9)]:
  - @dashcommerce/core@0.2.2

## 0.3.2

### Patch Changes

- Updated dependencies [[`55ca9fa`](https://github.com/emdashCommerce/dashcommerce/commit/55ca9fa5408619f717c92ff020e59ce04a49a4cd), [`bcdad21`](https://github.com/emdashCommerce/dashcommerce/commit/bcdad21b6519442c5f62bdf6b5382179f69d5570)]:
  - @dashcommerce/core@0.2.1

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

- Updated dependencies [[`ef8360b`](https://github.com/emdashCommerce/dashcommerce/commit/ef8360be32b6f99fd07cc3b0a47cb913c96e724c), [`b865dd7`](https://github.com/emdashCommerce/dashcommerce/commit/b865dd78bfb2b4d6805c7aa9526d85819da7a5ee)]:
  - @dashcommerce/core@0.2.0

## 0.3.0

### Minor Changes

- [#12](https://github.com/emdashCommerce/dashcommerce/pull/12) [`321e810`](https://github.com/emdashCommerce/dashcommerce/commit/321e810383dc784f9e8f0512dba55a309eae3336) Thanks [@cavewebs](https://github.com/cavewebs)! - Upgrade to emdash 0.6.0.

  - `@dashcommerce/core`: widen `emdash` peer range to `>=0.5.0 <0.7.0`. Bump the bundled devDeps (`emdash`, `@emdash-cms/admin`) to `^0.6.0` so the package builds against current types. No public API changes.
  - `@dashcommerce/starter`: bump `emdash` and `@emdash-cms/cloudflare` to `^0.6.0`. 0.6's [release fix for `syncSearchState` FTS-during-field-creation](https://github.com/emdash-cms/emdash/pull/595) eliminates the partial-DDL issue that was truncating collection schemas on Cloudflare D1 setup and throwing mid-seed on Postgres. Storefront surfaced zero typecheck errors on the upgrade — no porting required.

  Stripe webhook body-clone patch regenerated for 0.6 (`patches/emdash@0.6.0.patch`) since the upstream `request.clone().json()` fix still isn't in place.

### Patch Changes

- Updated dependencies [[`321e810`](https://github.com/emdashCommerce/dashcommerce/commit/321e810383dc784f9e8f0512dba55a309eae3336)]:
  - @dashcommerce/core@0.1.4

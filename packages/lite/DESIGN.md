# DashCommerce Lite: design

DashCommerce Lite is the sandboxed version of DashCommerce. It can be listed
on the EmDash plugin registry and installed from the admin UI. It covers a
small part of the native plugin (`packages/core`): simple products, a cart,
Stripe hosted Checkout, a signed Stripe webhook that marks orders paid, and
Block Kit pages for orders and settings.

The native plugin is unchanged and remains the full option.

## Why a separate package

The registry accepts only sandboxed plugins. `packages/core` is
`format: "native"` and depends on things the sandbox does not offer: React
admin pages and widgets, Portable Text blocks, Astro storefront components,
constructor options, and route handlers that return Web `Response` objects
with `Set-Cookie`. Its sandbox entry also minifies to about 171 KB, over the
128 KB per-file cap. Lite is a new entry point built for the sandbox rules
from the start, and it reuses core's logic where that logic is portable.

## Architecture

```
storefront (theme JS)                    EmDash host                     Lite (sandbox isolate)
--------------------                    ------------                    ----------------------
fetch /_emdash/api/plugins/      --->   route dispatcher       --->     src/plugin.ts routes
  dashcommerce-lite/<route>             (auth, CSRF, body                 cart-routes.ts
  X-DashCommerce-Cart: <token>          parsing, header                   checkout.ts
                                        allowlist)                        webhook.ts
Stripe  ---- POST stripe/webhook --->                                     admin.ts (Block Kit)
                                        ctx.kv / ctx.settings /  <---     shared.ts -> ../core/src/*
                                        ctx.storage / ctx.content
                                        ctx.http (api.stripe.com) <---
```

Source layout (`packages/lite/src`):

| File | Purpose |
| --- | --- |
| `plugin.ts` | Route table (`SandboxedPlugin` default export). |
| `cart.ts` | Token minting, hashing, KV storage, expiry, cart view. |
| `cart-routes.ts` | `cart`, `cart/items`, `cart/item`, `cart/clear`. |
| `products.ts` | Reads `products` content entries, checks sellability, prices them. |
| `checkout.ts` | Re-prices the cart, writes a pending order, creates the Stripe Checkout Session. |
| `webhook.ts` | Verifies the Stripe signature, dedupes events, updates orders. |
| `orders.ts` | Order shape, compare-and-set updates, admin status changes. |
| `admin.ts` | Block Kit Orders and Settings pages. |
| `settings.ts` | Settings defaults and validation. |
| `shared.ts` | The list of modules imported from core. |

All storefront routes return JSON. EmDash wraps it as
`{ "success": true, "data": ... }`. Sandboxed routes cannot choose an HTTP
status, so expected failures come back as
`data = { "ok": false, "error": { "code": "...", "message": "..." } }`.
Storefront code must check `data.ok`. The webhook is the one raw route
(`response: "raw"` with `pluginResponse()`), so it can answer 400 for a bad
signature and 500 when processing fails, which makes Stripe retry.

## Token cart

Sandboxed routes cannot read or set cookies, so the `dashcommerce_sid`
cookie used by core is replaced by a cart token.

- The first `cart/items` call without a valid token mints one: 32 random
  bytes, base64url (43 characters). Every successful cart response returns
  `token`. The storefront stores it (localStorage is the expected place) and
  sends it on later calls in the `X-DashCommerce-Cart` header. Routes declare
  that header in `request.headers`, which is the only way a custom header
  reaches a sandboxed handler.
- KV holds the cart at `cart:<sha256(token)>`. The raw token is never
  stored, so reading KV does not give anyone a usable token. The hash doubles
  as the cart id that orders keep.
- Carts expire 30 days after the last write. Expired carts are deleted on
  read. A cleanup cron is on the checklist.
- A cart holds at most 20 lines and 99 of one product. This bounds the work
  done in one request (see "Cloudflare limits" below).
- If the store currency changes, existing carts start over empty instead
  of mixing currencies.
- The token is a bearer secret for the cart only. It cannot read orders.
  Order status needs the separate `orderKey` returned by checkout.

Public routes still get EmDash's cross-origin protection: a request with a
different `Origin` gets 403, so another site cannot drive a shopper's cart
from the browser. Same-origin theme code and server-side calls work.

## Checkout and webhook

`checkout/session`:

1. Loads the cart by token. Fails with `CART_EMPTY`, `STRIPE_NOT_CONFIGURED`
   and similar codes before any Stripe call.
2. Re-prices every line from the `products` collection. The browser never
   supplies prices. If the total changed it saves the corrected cart and
   returns `CART_CHANGED` so the shopper can review it.
3. Writes a `pending` order, then creates a Checkout Session with core's
   `createCheckoutSession()` (`mode=payment`, `client_reference_id` and
   `metadata.orderId` set to the order id, idempotency key
   `dcl_checkout_<orderId>`). A shipping address is collected only when
   the cart has a physical item and shipping countries are configured.
4. Returns `{ url, orderId, orderKey, orderNumber }`. The storefront
   redirects to `url`.

`stripe/webhook` (`body: "text"`, header allowlist `stripe-signature`):

1. Verifies the signature over the exact raw body with core's Web Crypto
   `verifyStripeSignature()` (HMAC-SHA256, 5 minute tolerance). No dispatch
   patches are involved.
2. Ignores event types it does not handle. Acknowledges an event id it has
   already processed (`stripe_events` collection) without side effects.
3. `checkout.session.completed` with `payment_status=paid`, or
   `checkout.session.async_payment_succeeded`: marks the order `paid` and
   `processing`, stores the PaymentIntent id, email and shipping address,
   and deletes the cart. If Stripe's `amount_total` or currency does not
   match the order, the order goes `on-hold` with an `amountMismatch`
   record for the merchant.
4. `checkout.session.async_payment_failed` marks the order failed.
   `checkout.session.expired` cancels a still-pending order.
5. Order writes use `getVersioned` plus `compareAndSet`, so two concurrent
   deliveries of the same event cannot both apply.

## Code shared with core

Lite imports these modules from `packages/core/src` through
`src/shared.ts`; the Lite build inlines them:

| Core module | Used for |
| --- | --- |
| `money.ts` | Integer minor-unit money, formatting. |
| `cart/calculate.ts` (`recalculate`) | Cart totals. |
| `cart/store.ts` (`newCart`) | Empty cart shape. |
| `products/normalize.ts` | snake_case product fields to `ProductFields`. |
| `products/pricing.ts` (`resolvePrice`) | Price for a currency. |
| `stripe/client.ts`, `stripe/checkout-sessions.ts` | Stripe form encoding, Checkout Session creation via `ctx.http`. |
| `stripe/webhook-verify.ts` | Signature verification. |
| `orders/status.ts` (`canTransition`) | Order state machine. |
| `util/ids.ts` (`randomId`) | Ids and order keys. |
| `types.ts` | `CartState`, `CartLineItem`, `OrderStatus`, `PaymentStatus`, `ProductFields`. |

None of these import React, Astro, `node:*` or the `emdash` runtime (only
`import type`). `test/unit/shared-imports.test.ts` walks the import graph
from `src/plugin.ts` and fails if a runtime package import appears, so a
change in core that would break the sandbox build is caught in CI. Core
itself is not modified by this package.

Not shared (native-only or out of Lite scope): React admin, Astro
components, cookie session helpers, coupons, shipping zones, tax tables,
variants, inventory decrement, subscriptions, Connect, emails, downloads.

## Permissions

```jsonc
"capabilities": ["content:read", "network:request"],
"allowedHosts": ["api.stripe.com"]
```

- `content:read`: read prices and stock from the site's `products`
  collection. Without it Lite would need its own product store and editor.
- `network:request` limited to `api.stripe.com`: create Checkout Sessions.
  Stripe sends webhooks to us, so no other host is needed.
- Not requested: `content:write` (so stock is not decremented, see
  checklist), `email:send`, `users:read`, `media:read`.
- `ctx.settings`, `ctx.kv` and the two declared storage collections
  (`orders`, `stripe_events`) need no capability.
- Stripe keys are `type: "secret"` settings, encrypted by EmDash with
  `EMDASH_ENCRYPTION_KEY`. The settings page shows only whether a key is
  set. A Stripe restricted key with write access to Checkout Sessions is
  enough.
- Public routes: `cart`, `cart/items`, `cart/item`, `cart/clear`,
  `checkout/session`, `order`, `stripe/webhook`. `admin` is private and uses
  the default `plugins:manage` permission.

## Storefront usage

Base path: `/_emdash/api/plugins/dashcommerce-lite`.

| Route | Method | Body / query | Returns (`data`) |
| --- | --- | --- | --- |
| `cart` | GET | (header) | `{ ok, token, cart }`, `token: null` when there is no cart |
| `cart/items` | POST | `{ productId, quantity? }` | `{ ok, token, cart }` |
| `cart/item` | POST | `{ lineId, quantity }` (0 removes) | `{ ok, token, cart }` |
| `cart/clear` | POST | `{}` | `{ ok, token, cart }` |
| `checkout/session` | POST | `{ email? }` | `{ ok, url, orderId, orderKey, orderNumber }` |
| `order` | GET | `?id=&key=` | `{ ok, order }` |

`productId` is the content entry id of a published `products` entry.

```js
const BASE = "/_emdash/api/plugins/dashcommerce-lite";
const KEY = "dashcommerce-lite-cart";

async function call(route, { method = "POST", body } = {}) {
  const token = localStorage.getItem(KEY);
  const res = await fetch(`${BASE}/${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-DashCommerce-Cart": token } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const { data } = await res.json();
  if (data?.token) localStorage.setItem(KEY, data.token);
  if (!data?.ok) throw Object.assign(new Error(data?.error?.message), data?.error);
  return data;
}

await call("cart/items", { body: { productId, quantity: 1 } });
const { url } = await call("checkout/session", { body: {} });
location.assign(url);
```

The success page reads `order` and `key` from its query string (the
default success URL is `/checkout/success?order={ORDER_ID}&key={ORDER_KEY}`)
and calls `order?id=...&key=...` to show the status. The webhook may land a
moment after the redirect, so the page should poll briefly while
`paymentStatus` is `pending`.

A small script or Astro component kit for themes is on the checklist.
Sandboxed plugins cannot inject scripts into pages, so themes include it
themselves.

## Cloudflare limits

On Cloudflare each sandboxed call gets 50 ms CPU and 10 subrequests.

- CPU: the hot paths are a SHA-256 of the token, HMAC verification and
  small JSON work. Unit timings are well under a millisecond.
- Subrequests: the only `fetch` is one Stripe call per checkout. It is not
  yet confirmed whether bridge calls (`ctx.kv`, `ctx.content`,
  `ctx.storage`, `ctx.settings`) count toward the 10. Checkout makes about
  6 + (lines) bridge calls. If they count, checkout needs batching
  (for example `content.list` with an `id in [...]` filter) or a lower
  line cap. This needs a test on a real Cloudflare deployment.

## Bundle size

`emdash-plugin bundle` output: `backend.js` about 32 KB, total about 35 KB
(caps: 128 KB per file, 256 KB total). Lite does not use zod; input
validation is hand-written in `validate.ts`. `bun run size` prints the
numbers and fails above a 96 KB working budget for `backend.js`.

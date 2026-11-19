# @dashcommerce/paystack

A Paystack `PaymentProvider` for DashCommerce. Customers pay on Paystack's hosted page by card or M-Pesa (Paystack's `mobile_money` channel). DashCommerce creates the order when Paystack's signed `charge.success` webhook arrives and the transaction is confirmed with Paystack.

> **Status: not yet usable on a live site.** Released `@dashcommerce/core` (0.3.5) has the provider seam this package plugs into, but it is still missing two things a merchant needs. See [What core still needs](#what-core-still-needs). The package is `private` and is not published.

## What it does

| Area | Behaviour |
|---|---|
| Checkout | `POST /transaction/initialize`, then a redirect to Paystack's hosted page. The reference is `dc-<orderDraftId>`, since Paystack allows only `-`, `.`, `=` and alphanumerics |
| Webhook | Verifies `x-paystack-signature`, an HMAC-SHA512 of the raw body keyed on the secret key, in constant time with Web Crypto. Core routes the webhook here from that header |
| Confirmation | Core calls `getPaymentStatus`, which uses `GET /transaction/verify/:reference`, before creating the order. The amount and currency come from Paystack's record, not the webhook body |
| Duplicates | `providerEventId` is `charge.success:<transaction id>`, and core ignores a repeat delivery |
| Refunds | `POST /refund` by transaction reference. The `refundRequestId` goes in `merchant_note`. Paystack has no idempotency key, so a retried refund request can refund twice. Check the Paystack dashboard before retrying |
| Currencies | KES, NGN, GHS, ZAR and USD. Your Paystack account must be enabled for the currency you sell in |
| Not supported | Embedded checkout (core's embedded mode is Stripe-only), coupons on the hosted page, Connect splits and subscriptions. `capabilities` declares all three as `false` |

Paystack sends no `charge.failed` webhook. A payment that fails or is abandoned leaves the checkout draft unpaid, and no order is created.

## Use

```ts
// The module your EmDash site loads at runtime, next to dashcommerce()
import "@dashcommerce/paystack"; // registers the "paystack" provider
```

Importing twice is harmless. If a different provider already holds the `paystack` id, the import throws instead of silently replacing it.

Settings, all in DashCommerce's plugin KV:

| Key | Value |
|---|---|
| `settings:paymentProvider` | `paystack` |
| `settings:checkoutMode` | `hosted` |
| `settings:paystackSecretKey` | your Paystack secret key (`sk_test_…` while testing) |
| `settings:paystackWebhookSecret` | **the same secret key.** Paystack signs webhooks with the secret key; core reads the signing secret from this setting |

Webhook URL to enter in the Paystack dashboard:

```
https://<your-site>/_emdash/api/plugins/dashcommerce/checkout/webhook
```

## What core still needs

Both of these belong in core, so they are proposed upstream rather than patched here:

1. **Outbound host.** Core's plugin descriptor allows HTTP only to `api.stripe.com` and `files.stripe.com`, and offers no way to add hosts. Calls to `api.paystack.co` go through `ctx.http.fetch`, which enforces that list.
2. **Credentials.** The admin settings API accepts only Stripe keys, so `paystackSecretKey` and `paystackWebhookSecret` cannot be saved through it. Core already *reads* them.

## Develop

```sh
bun test           # unit tests, plus checkout → webhook → order through core's real routes
bun run typecheck
bun run build
```

The integration tests use a Paystack stand-in that only answers `verify` for references it issued. A provider that verifies by the wrong identifier fails there.

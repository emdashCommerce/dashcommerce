# @dashcommerce/paystack

A Paystack `PaymentProvider` for DashCommerce. Customers pay on Paystack's hosted page by card or M-Pesa (Paystack's `mobile_money` channel). DashCommerce creates the order when Paystack's signed `charge.success` webhook arrives and the transaction is confirmed with Paystack.

> **Status: not yet usable on a live site.** Released `@dashcommerce/core` (0.3.5) has the provider seam this package plugs into, but it is still missing things a merchant needs. See [What core still needs](#what-core-still-needs). The package is `private` and is not published.

## What it does

| Area | Behaviour |
|---|---|
| Checkout | `POST /transaction/initialize`, then a redirect to Paystack's hosted page. The reference is `dc-<orderDraftId>`, since Paystack allows only `-`, `.`, `=` and alphanumerics |
| Webhook | Verifies both of Paystack's signature schemes in constant time with Web Crypto, choosing by the header value. See [Webhook signatures](#webhook-signatures) |
| Confirmation | Core calls `getPaymentStatus`, which uses `GET /transaction/verify/:reference`, before creating the order. The amount and currency come from Paystack's record, not the webhook body. `success`, `reversed` and `reversal-pending` count as paid (a refunded payment was still paid); `failed` as failed; `abandoned`, `ongoing`, `pending`, `processing` and `queued` as pending. An unknown status is reported as pending, never as paid. Caveat: core asks only "paid or not", so if a first `charge.success` delivery fails and the payment is refunded in full from the Paystack dashboard before Paystack's retry, the retry still creates the order. Core needs refunded amounts to close this (proposed upstream) |
| Duplicates | Paystack webhooks carry no event id, so `providerEventId` is left empty and core relies on its unique index on the payment reference: a repeat delivery never creates a second order. This also lets Paystack's retry succeed after a first delivery failed (core records event ids before handling and never releases them) |
| Draft lookup | From `metadata.orderDraftId`, or from the `dc-<draftId>` reference if Paystack returns no metadata |
| Return URL | Core's success URL minus Stripe's `{CHECKOUT_SESSION_ID}` placeholder; Paystack appends its own `trxref` and `reference` |
| Refunds | `POST /refund` by transaction reference, with `(refundRequestId=<id>)` in `merchant_note`. Paystack takes no idempotency key for refunds and accepts an identical second refund as a new one, so the provider first looks up the transaction's numeric id, lists its refunds, and returns any non-failed refund already tagged with this `refundRequestId` instead of creating another. The tag is read only from the end of the note, and brackets are stripped from the reason, so a reason cannot pose as another request. This guards retries, not two simultaneous calls with the same id: both could pass the check before either refund exists, so core must not run the same refund request concurrently. M-Pesa refunds go back to the customer's phone. Refund statuses map as `processed` → succeeded, `failed` → failed, and `pending`, `processing`, `needs-attention` → pending. Paystack's `refund.*` webhooks are not handled yet (core has no refund-status event), so a refund stays `pending` in DashCommerce |
| Currencies | KES, NGN, GHS, ZAR and USD. Your Paystack account must be enabled for the currency you sell in |
| Not supported | Embedded checkout (core's embedded mode is Stripe-only), coupons on the hosted page, Connect splits and subscriptions. `capabilities` declares all three as `false` |

## Webhook signatures

Paystack sends two headers ([docs](https://paystack.com/docs/v2/developer-tools/integration/webhooks)):

| Header | Format | Keyed with | Replay window |
|---|---|---|---|
| `Paystack-Signature` (current) | `t=<unix>,v1=<whk_ key id>:<hex HMAC-SHA512 of "t." + raw body>`; two `v1` values while a secret is rotated, any match accepted | the whole `whsec_` signing secret | `t` must be within 300 seconds of the server clock |
| `x-paystack-signature` (deprecated) | hex HMAC-SHA512 of the raw body | the `sk_` secret key | none |

The provider verifies either, so whichever secret you put in `settings:paystackWebhookSecret` must match the header that reaches it.

**Today, core passes only `x-paystack-signature`.** Core extracts one header per provider, `x-<id>-signature`, so `Paystack-Signature` never reaches the provider. Until core passes all request headers to `verifyWebhook` (proposed upstream), keep the `sk_` key as the webhook secret. Without a timestamp a captured webhook can be replayed, but it cannot create a second order or an order Paystack's own records do not confirm.

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
| `settings:paystackWebhookSecret` | with today's core, **the same secret key** (see [Webhook signatures](#webhook-signatures)). Once core passes all headers: the `whsec_` signing secret |

The setup we are working towards, once core accepts it, is a restricted `rk_` key with only `transactions:write` and `disputes_refunds:write`, plus the `whsec_` signing secret, and no `sk_` key on the site at all. Do not delete the `sk_` key from Paystack before then: Paystack stops sending `x-paystack-signature` once it is gone.

Webhook URL to enter in the Paystack dashboard:

```
https://<your-site>/_emdash/api/plugins/dashcommerce/checkout/webhook
```

## What core still needs

These belong in core, so they are proposed upstream rather than patched here:

1. **Outbound host.** Core's plugin descriptor allows HTTP only to `api.stripe.com` and `files.stripe.com`, and offers no way to add hosts. Calls to `api.paystack.co` go through `ctx.http.fetch`, which enforces that list; EmDash 1.5 throws.
2. **Credentials.** The admin settings API accepts only Stripe keys, so `paystackSecretKey` and `paystackWebhookSecret` cannot be saved through it, and an `rk_` or `whsec_` value would be refused. Core already *reads* them.
3. **All request headers to `verifyWebhook`**, so `Paystack-Signature` can be verified.
4. **A refund-status event**, so `refund.*` webhooks (or polling Fetch Refund) can move a refund out of `pending`. Live refunds can take days.

## Develop

```sh
bun test           # unit tests, plus checkout → webhook → order through core's real routes
bun run typecheck
bun run build
```

The integration tests use a Paystack stand-in that only answers `verify` for references it issued. A provider that verifies by the wrong identifier fails there.

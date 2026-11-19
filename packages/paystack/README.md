# @dashcommerce/paystack

A Paystack `PaymentProvider` for DashCommerce. Customers pay on Paystack's hosted page by card or M-Pesa (Paystack's `mobile_money` channel). DashCommerce creates the order when Paystack's signed `charge.success` webhook arrives and the transaction is confirmed with Paystack.

> **Status: needs core with the provider-enablement changes** (the companion core PR). Released core 0.3.5 cannot call `api.paystack.co`, save Paystack keys, pass `Paystack-Signature`, or take refund updates. See [Core requirements](#core-requirements). The package is `private` and is not published.

## What it does

| Area | Behaviour |
|---|---|
| Checkout | `POST /transaction/initialize`, then a redirect to Paystack's hosted page. The reference is `dc-<orderDraftId>`, since Paystack allows only `-`, `.`, `=` and alphanumerics |
| Webhook | Verifies both of Paystack's signature schemes in constant time with Web Crypto, choosing by the header value. See [Webhook signatures](#webhook-signatures) |
| Confirmation | Core calls `getPaymentStatus`, which uses `GET /transaction/verify/:reference`, before creating the order. The amount and currency come from Paystack's record, not the webhook body. `success`, `reversed` and `reversal-pending` count as paid (a refunded payment was still paid); `failed` as failed; `abandoned`, `ongoing`, `pending`, `processing` and `queued` as pending. An unknown status is reported as pending, never as paid. Caveat: core asks only "paid or not", so if a first `charge.success` delivery fails and the payment is refunded in full from the Paystack dashboard before Paystack's retry, the retry still creates the order. Core needs refunded amounts to close this (proposed upstream) |
| Duplicates | Paystack webhooks carry no event id, so `providerEventId` is left empty and core relies on its unique index on the payment reference: a repeat delivery never creates a second order, and Paystack's retry after a failed first delivery still creates it |
| Draft lookup | From `metadata.orderDraftId`, or from the `dc-<draftId>` reference if Paystack returns no metadata |
| Return URL | Core's success URL minus Stripe's `{CHECKOUT_SESSION_ID}` placeholder; Paystack appends its own `trxref` and `reference` |
| Refunds | `POST /refund` by transaction reference, with `(refundRequestId=<id>)` in `merchant_note`. Paystack takes no idempotency key for refunds and accepts an identical second refund as a new one, so the provider first looks up the transaction's numeric id, lists its refunds, and returns any non-failed refund already tagged with this `refundRequestId` instead of creating another. The tag is read only from the end of the note, and brackets are stripped from the reason, so a reason cannot pose as another request. This guards retries, not two simultaneous calls with the same id: both could pass the check before either refund exists, so core must not run the same refund request concurrently. M-Pesa refunds go back to the customer's phone. Refund statuses map as `processed` → succeeded, `failed` → failed, and `pending`, `processing`, `needs-attention` → pending. `refund.*` webhooks become core's `refund.updated`, matched by the numeric refund id. Paystack's documented sample shows only `refund_reference`, so an event without an id is left unhandled until a real payload confirms the shape |
| Currencies | KES, NGN, GHS, ZAR and USD. Your Paystack account must be enabled for the currency you sell in |
| On-page checkout | With checkout set to "On your page", Paystack's Popup opens over the store's checkout using the `access_code` from initialise. `inline.js` loads only when the customer presses Pay. The Popup's success callback only sends the customer to the thank-you page; the order still comes from the signed webhook and a live verify |
| Customer details | Paystack's page collects neither email nor address, so the provider leaves `collectsCustomerDetails` unset and DashCommerce's checkout asks for them before payment |
| Not supported | Coupons on Paystack's page, Connect splits and subscriptions. `capabilities` declares all three as `false` |

## Webhook signatures

Paystack sends two headers ([docs](https://paystack.com/docs/v2/developer-tools/integration/webhooks)):

| Header | Format | Keyed with | Replay window |
|---|---|---|---|
| `Paystack-Signature` (current) | `t=<unix>,v1=<whk_ key id>:<hex HMAC-SHA512 of "t." + raw body>`; two `v1` values while a secret is rotated, any match accepted | the whole `whsec_` signing secret | `t` must be within 300 seconds of the server clock |
| `x-paystack-signature` (deprecated) | hex HMAC-SHA512 of the raw body | the `sk_` secret key | none |

The provider verifies the header that matches the webhook secret you saved: `Paystack-Signature` for a `whsec_` secret, `x-paystack-signature` for an `sk_` key. Use `whsec_`: it adds the replay window, and lets you keep the `sk_` key off the site. With an `sk_` key, a captured webhook can be replayed, but it cannot create a second order or an order Paystack's own records do not confirm.

Paystack sends no `charge.failed` webhook. A payment that fails or is abandoned leaves the checkout draft unpaid, and no order is created.

## Use

1. **Register the provider at runtime.** Import the package in a module the server loads before any request, such as `src/middleware.ts`:

   ```ts
   import "@dashcommerce/paystack"; // registers the "paystack" provider
   ```

   Importing it in `astro.config.mjs` is not enough: that file runs only at build time. Importing twice is harmless. If a different provider already holds the `paystack` id, the import throws instead of silently replacing it.

2. **Allow Paystack's API host:**

   ```ts
   emdash({ plugins: [dashcommerce({ allowedHosts: ["api.paystack.co"] })] });
   ```

3. **Choose Paystack and enter its keys** in Settings → Payment provider:

   | Field | Value |
   |---|---|
   | Secret or restricted key | best: a restricted key (`rk_test_…`) with only `transactions:write` and `disputes_refunds:write`; or the secret key (`sk_test_…`) |
   | Webhook signing secret | the `whsec_…` secret from Developers → API configuration; or, if you have none yet, the `sk_` secret key |

   Save, then press **Test Paystack connection**. It makes one read-only call (verifying a reference that can't exist) and says whether Paystack accepts the key, in test or live mode, and whether it can read transactions.

   Under **How customers pay**, choose hosted (Paystack's page) or on your page (the Popup). Do not delete the `sk_` key from Paystack before your webhooks verify with `whsec_`: Paystack stops sending `x-paystack-signature` once it is gone.

4. **For on-page checkout, load the browser client** in your checkout page's client script, so Vite bundles it:

   ```astro
   <script>
     import "@dashcommerce/paystack/checkout-client";
   </script>
   ```

   If your site sends a Content-Security-Policy, allow `https://js.paystack.co` for scripts and Paystack's checkout frames.

5. **Set the webhook URL** in the Paystack dashboard:

   ```
   https://<your-site>/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=paystack
   ```

## Core requirements

From core (the companion core PR, proposed together with this package):

1. **`dashcommerce({ allowedHosts })`.** Without it, `ctx.http.fetch` refuses `api.paystack.co`, and EmDash 1.5 throws.
2. **Per-provider credentials** in the settings API and admin, accepting the `rk_` and `whsec_` prefixes this package declares in `credentialFields`.
3. **All request headers in `verifyWebhook`** plus `webhookHeaders` routing, so `Paystack-Signature` reaches the provider.
4. **`refund.updated`**, so `refund.*` webhooks move a refund out of `pending`. Live refunds can take days.
5. **`checkConnection`**, for the Test connection button in Settings. Optional: without it the button doesn't show.

## Develop

```sh
bun test           # unit tests, plus checkout → webhook → order through core's real routes
bun run typecheck
bun run build
```

The integration tests use a Paystack stand-in that only answers `verify` for references it issued. A provider that verifies by the wrong identifier fails there.

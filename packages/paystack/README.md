# @dashcommerce/paystack

A Paystack `PaymentProvider` for DashCommerce. Customers pay on Paystack's hosted page by card or M-Pesa (Paystack's `mobile_money` channel). DashCommerce creates the order when Paystack's signed `charge.success` webhook arrives and the transaction is confirmed with Paystack.

> **Needs `@dashcommerce/core` 0.4.0 or later.** 0.4.0 is the first core release that can call `api.paystack.co`, save Paystack keys, pass `Paystack-Signature` to the provider and take refund updates. This package's first release, 0.1.0, goes out alongside core 0.5.0. It accepts any core from 0.4.0 up to 1.0: this repository's CI runs the package's tests against the current core on every pull request, so each core release made here has been tested with it.

## What it does

| Area | Behaviour |
|---|---|
| Checkout | `POST /transaction/initialize`, then a redirect to Paystack's hosted page. The reference is `dc-<orderDraftId>`, since Paystack allows only `-`, `.`, `=` and alphanumerics |
| Webhook | Verifies both of Paystack's signature schemes in constant time with Web Crypto, choosing by the header value. See [Webhook signatures](#webhook-signatures) |
| Confirmation | Core calls `getPaymentStatus`, which uses `GET /transaction/verify/:reference`, before creating the order. The amount and currency come from Paystack's record, not the webhook body. `success`, `reversed` and `reversal-pending` count as paid (Paystack reports the last two after partial refunds too); `failed` as failed; `abandoned`, `ongoing`, `pending`, `processing` and `queued` as pending. An unknown status is reported as pending, never as paid. A `reversed` or `reversal-pending` payment whose refunds (other than failed ones) add up to the whole amount is reported as failed, so a webhook retry that arrives after a full refund creates no order |
| Duplicates | Paystack webhooks carry no event id, so the provider builds one: `charge.success:<reference>` and `<event>:<refund id>` (for example `refund.failed:19244346`). Core records it before the handler runs, so a repeat or overlapping delivery is skipped, and a failed refund is reversed once. If confirming with Paystack fails (Paystack down, or the payment not yet successful), core releases the record, so Paystack's retry still creates the order. Any other failure keeps the record, as it does for Stripe: Paystack's retry is then answered as a duplicate, and the order has to be recovered by hand. Core's unique index on the payment reference also refuses a second order for the same payment |
| Draft lookup | From `metadata.orderDraftId`, or from the `dc-<draftId>` reference if Paystack returns no metadata |
| Return URL | Core's success URL minus Stripe's `{CHECKOUT_SESSION_ID}` placeholder; Paystack appends its own `trxref` and `reference` |
| Refunds | `POST /refund` by transaction reference, with `(refundRequestId=<id>)` in `merchant_note`. Paystack takes no idempotency key for refunds and accepts an identical second refund as a new one, so the provider first looks up the transaction's numeric id, lists its refunds, and returns any non-failed refund already tagged with this `refundRequestId` instead of creating another. The tag is read only from the end of the note, and brackets are stripped from the reason, so a reason cannot pose as another request. This guards retries, not two simultaneous calls with the same id: both could pass the check before either refund exists, so core must not run the same refund request concurrently. M-Pesa refunds go back to the customer's phone. Refund statuses map as `processed` → succeeded, `failed` → failed, and `pending`, `processing`, `needs-attention` → pending. `refund.*` webhooks become core's `refund.updated`, matched by the refund id. Paystack's documented sample shows only `refund_reference`, but real test-mode deliveries carry `id` (as a string, e.g. `"19244346"`) and a null `refund_reference`; an event without an id is left unhandled rather than matched by guesswork |
| Currencies | KES, NGN, GHS, ZAR and USD. Your Paystack account must be enabled for the currency you sell in |
| On-page checkout | With checkout set to "On your page", Paystack's Popup opens over the store's checkout using the `access_code` from initialise. `inline.js` loads only when the customer presses Pay. The Popup's success callback only sends the customer to the thank-you page; the order still comes from the signed webhook and a live verify |
| Customer details | Paystack's page collects neither email nor address, so the provider leaves `collectsCustomerDetails` unset and DashCommerce's checkout asks for them before payment |
| Not supported | Coupons on Paystack's page, Connect splits and subscriptions. `capabilities` declares all three as `false` |

## Webhook signatures

Paystack documents two headers ([docs](https://paystack.com/docs/v2/developer-tools/integration/webhooks)):

| Header | Format | Keyed with | Replay window |
|---|---|---|---|
| `Paystack-Signature` (current) | `t=<unix>,v1=<whk_ key id>:<hex HMAC-SHA512 of "t." + raw body>`; two `v1` values while a secret is rotated, any match accepted | the whole `whsec_` signing secret | `t` must be within 300 seconds of the server clock |
| `x-paystack-signature` (deprecated) | hex HMAC-SHA512 of the raw body | the `sk_` secret key | none |

The provider checks each header with the key it is signed with:

- `Paystack-Signature` with a saved `whsec_` secret. When it is present and a `whsec_` is saved, its result is final, so a replay outside the 300-second window cannot pass on the legacy header sent with it.
- Otherwise `x-paystack-signature`, with an `sk_` secret key saved in either field: the Paystack key or the webhook secret.

Paystack does not always send both. In a test-mode run (November 2026) its deliveries carried only `x-paystack-signature`, on an account that had a `whsec_` secret. Those verify as long as an `sk_` key is saved. If your Paystack key is a restricted `rk_` key, save the `sk_` key as the webhook secret, or webhooks are refused with a 400 that says so. Paystack retries refused deliveries, so fixing the setting recovers them.

Prefer `whsec_` where Paystack sends `Paystack-Signature`: it adds the replay window. With only `x-paystack-signature`, a captured webhook can be replayed, but it cannot create a second order or an order Paystack's own records do not confirm.

Paystack sends no `charge.failed` webhook. A payment that fails or is abandoned leaves the checkout draft unpaid, and no order is created.

## Use

1. **Install** both packages:

   ```sh
   npm install @dashcommerce/core @dashcommerce/paystack
   ```

2. **Register the provider at runtime.** Import the package in a module the server loads before any request, such as `src/middleware.ts`:

   ```ts
   import "@dashcommerce/paystack"; // registers the "paystack" provider
   ```

   Importing it in `astro.config.mjs` is not enough: that file runs only at build time. Importing twice is harmless. If a different provider already holds the `paystack` id, the import throws instead of silently replacing it.

3. **Allow Paystack's API host:**

   ```ts
   emdash({ plugins: [dashcommerce({ allowedHosts: ["api.paystack.co"] })] });
   ```

4. **Choose Paystack and enter its keys** in Settings → Payment provider:

   | Field | Value |
   |---|---|
   | Secret or restricted key | best: a restricted key (`rk_test_…`) with only `transactions:write` and `disputes_refunds:write`; or the secret key (`sk_test_…`) |
   | Webhook signing secret | the `whsec_…` secret from Developers → API configuration, or the `sk_` secret key. With a restricted `rk_` key above, use the `sk_` key here unless your deliveries carry `Paystack-Signature` (see [Webhook signatures](#webhook-signatures)) |

   Save, then press **Test Paystack connection**. It makes one read-only call (verifying a reference that can't exist) and says whether Paystack accepts the key, in test or live mode, and whether it can read transactions.

   Under **How customers pay**, choose hosted (Paystack's page) or on your page (the Popup). Do not delete the `sk_` key from Paystack before your webhooks verify with `whsec_`: Paystack stops sending `x-paystack-signature` once it is gone.

5. **For on-page checkout, load the browser client** in your checkout page's client script, so Vite bundles it:

   ```astro
   <script>
     import "@dashcommerce/paystack/checkout-client";
   </script>
   ```

   If your site sends a Content-Security-Policy, allow `https://js.paystack.co` for scripts and Paystack's checkout frames.

6. **Set the webhook URL** in the Paystack dashboard, including `?provider=paystack`:

   ```
   https://<your-site>/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=paystack
   ```

   Without the query, core picks the provider from the signature header. That works today, but the query keeps Paystack's webhooks going to Paystack even if another provider later uses a header with the same name.

## Develop

```sh
bun test           # unit tests, plus checkout → webhook → order through core's real routes
bun run typecheck
bun run build
```

The integration tests use a Paystack stand-in that only answers `verify` for references it issued. A provider that verifies by the wrong identifier fails there.

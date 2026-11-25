# @dashcommerce/flutterwave

A Flutterwave `PaymentProvider` for DashCommerce. Customers pay on Flutterwave's hosted checkout, or in Flutterwave Inline over the store's own checkout, by card, M-Pesa or mobile money. DashCommerce creates the order when Flutterwave's signed `charge.completed` webhook arrives and the transaction is confirmed with Flutterwave.

> **Needs `@dashcommerce/core` 0.4.0 or later.** 0.4.0 is the first core release that can call `api.flutterwave.com`, save a second provider's keys, pass its webhook header to the provider and take refund updates. This package's first release, 0.1.0, goes out with it.

## What it does

| Area | Behaviour |
|---|---|
| Checkout | `POST /v3/payments`, then a redirect to the hosted link in `data.link`. The reference is `dc-<orderDraftId>`, so the draft can be recovered from `tx_ref` even without metadata |
| Amounts | Core works in integer minor units; Flutterwave's v3 API works in major units. The provider converts at the boundary: a KES 1,500.00 cart is sent as `1500`, and Flutterwave's `1500` comes back as `150000` |
| Webhook | Compares the `verif-hash` header with the secret hash saved in Settings → Webhooks, in constant time. See [Webhook verification](#webhook-verification) |
| Confirmation | Core calls `getPaymentStatus` before creating the order. A numeric reference is verified with `GET /v3/transactions/:id/verify`; anything else through `GET /v3/transactions/verify_by_reference?tx_ref=…`. The amount and currency come from Flutterwave's record, not the webhook body. `successful` counts as paid, `failed`/`cancelled` as failed, `pending` as pending. An unknown status is reported as pending, never as paid. Flutterwave keeps reporting `successful` after a refund (there is no `reversed` state), so a payment refunded in full before its order exists cannot be told apart from an unrefunded one; core's unique index on the payment reference still refuses a second order |
| Duplicates | Flutterwave webhooks carry no event id, so the provider builds one: `charge.completed:<transaction id>:successful`, `charge.completed:<id>:failed`, and `refund:<refund id>:<status>`. Core records it before the handler runs, so a repeat or overlapping delivery is skipped, and a failed refund is reversed once. If confirming with Flutterwave fails (Flutterwave down, or the payment not yet successful), core releases the record, so Flutterwave's retry still creates the order. Any other failure keeps the record, as it does for Stripe |
| Draft lookup | From `meta.orderDraftId` (object or JSON string), or from the `dc-<draftId>` reference |
| Return URL | Core's success URL minus Stripe's `{CHECKOUT_SESSION_ID}` placeholder; Flutterwave appends `status`, `tx_ref` and `transaction_id` |
| Refunds | `POST /v3/transactions/:id/refund`, with `(refundRequestId=<id>)` at the end of `comments`. Flutterwave takes no idempotency key for refunds, so the provider lists refunds and returns any non-failed refund already tagged with this `refundRequestId` instead of creating another. The tag is read only from the end of the comment, and brackets are stripped from the reason, so a reason cannot pose as another request. This guards retries, not two simultaneous calls with the same id: both could pass the check before either refund exists, so core must not run the same refund request concurrently. Flutterwave allows one partial refund to process per transaction at a time; a second answers `400 "A partial refund is currently processing on this transaction"`. `GET /v3/refunds` is not available to every key: a real test-mode key answered `400 {"message":"unauthorized"}` while it could create refunds. The provider logs that the retry check is unavailable and continues, so on such an account a retried refund can duplicate |
| Refund statuses | `completed`, `completed-bank-transfer`, `completed-momo`, `completed-mpgs`, `completed-offline` and `completed-preauth` → succeeded; `pending`, `pending-momo`, `pending-bank-transfer`, `pending-mpgs` and `processing` → pending; `failed` → failed. Flutterwave's minimum refund is NGN 100 / KES 10; a smaller request is refused by Flutterwave with a 400. `completed` can arrive while `meta.disburse_status` is `failed`, meaning Flutterwave accepted the refund but the customer has not been paid yet; the provider logs a warning in that case |
| Refund webhooks | Flutterwave posts the refund object itself, with no `event` field and capitalised `AmountRefunded`, `FlwRef` and `TransactionId`. The provider turns it into core's `refund.updated`, matched by the refund id |
| Currencies | NGN, USD, GBP, EUR, KES, GHS, ZAR, UGX, TZS, RWF, XOF, XAF, ZMW, MWK and EGP. Your Flutterwave account must be enabled for the currency you sell in |
| Payment options | With no channel hint, Flutterwave shows every method enabled on the account. A hint is mapped to Flutterwave's option names, and generic `mobile_money` is resolved by currency (`KES` → `mpesa`, `GHS` → `mobilemoneyghana`, …) |
| Customer details | Flutterwave's hosted page collects neither a shipping address nor a name for the store, so the provider leaves `collectsCustomerDetails` unset and DashCommerce's checkout asks for email and address before payment. The email is also required by `POST /v3/payments` |
| Not supported | Subscriptions. `capabilities` declares `subscriptions: false` |
| Discounts | Cart discounts are applied to the amount Flutterwave charges, so `capabilities.coupons` is `true`. No provider-side coupon object is created; the customer sees the net total on Flutterwave's page |
| Vendor onboarding | In Vendors, choose the country and bank or mobile-money channel, enter the account or mobile number, **verify the account name**, then create the collection subaccount. The full account number is never stored; the `RS_…` id, resolved name, bank and last four are. Re-adding the same bank account returns Flutterwave's existing subaccount instead of failing with "already exists", so a retry is safe. A manually created `RS_…` id can still be pasted in |
| On-page checkout | With checkout set to "On your page", Flutterwave Inline opens over the store's checkout using the public key and `tx_ref` from create-session. `checkout.flutterwave.com/v3.js` loads only when the customer presses Pay. The modal's `callback`/`onclose` only move the customer; the order still comes from the signed webhook and a live verify. `redirect_url` is deliberately not passed, because Inline gives it precedence over `callback` |
| Split payments | When the cart has vendor-owned items, core sends exact per-vendor minor amounts (`allocations`); the package maps each to `subaccounts: [{ id, transaction_charge_type: "flat_subaccount", transaction_charge }]` for hosted and Inline. Each vendor receives exactly the amount core computed. The subaccount's default `split_type` can be percentage or flat, but DashCommerce overrides it per payment so the shares stay exact. A vendor without an active account blocks checkout with a 409 rather than settling everything to the platform |

## Webhook verification

Flutterwave authenticates v3 webhooks with a shared secret, not an HMAC ([docs](https://developer.flutterwave.com/docs/webhooks)):

1. Set a **secret hash** under Settings → Webhooks in the Flutterwave dashboard. Any random value works.
2. Flutterwave sends it back verbatim in the `verif-hash` header on every delivery.
3. The provider compares the two in constant time and rejects a missing or different value.

There is no timestamp and no signature over the body, so a captured delivery can be replayed. That cannot create a second order: core deduplicates on the event id above, its unique index on the payment reference refuses a second order for the same transaction, and every order is confirmed against Flutterwave before it is written. A replay also cannot create an order for money that was never captured.

Enable **webhook retries** in the Flutterwave dashboard. Flutterwave retries a failed delivery three times, 30 minutes apart. A delivery refused with a 400 (wrong secret hash) is also retried, so fixing the setting recovers it.

Flutterwave sends `charge.completed` for failed attempts too, with `data.status` of `failed`. Those events release the checkout's stock lock; they never create an order.

## Test-mode notes (24 Nov 2026)

Verified against Flutterwave's real test API with a Nigerian test account (KES wallet):

- `GET /v3/balances`, `POST /v3/payments` and a real KES 1,500 M-Pesa payment all worked. The payment was completed through Flutterwave Inline on `checkout-v3.flutterwave.com`, which is the path `./checkout-client` now ships.
- A refund attempt on the split payment returned `400` with the nested message `Refund request successfully logged` and no refund id. The package treats that as a failure (the order is not marked refunded) and surfaces the nested message; the README points the merchant to the Flutterwave dashboard.
- Payout onboarding, through this package's methods: `listPayoutBanks` returned 598 NG banks; `resolvePayoutAccount` resolved test account `0690000033` to `Bale Gary`; `createPayoutAccount` created `RS_043B…` with the masked number and resolved name, then the probe subaccount was deleted.
- On-page, through this package's `./checkout-client`: Inline loaded from `checkout.flutterwave.com/v3.js` on Pay, completed a real KES 1,500 M-Pesa payment (transaction `10633614`), and the `callback` moved the page to `onFinished`. `getPaymentStatus` reported `succeeded` with `150000` minor units, and a KES 100 partial refund succeeded (refund `115045`).
- `GET /v3/transactions/:id/verify` and `verify_by_reference?tx_ref=` both returned the payment, and the provider's `getPaymentStatus` reported `succeeded` with `150000` minor units for a `1500` KES charge.
- A KES 500 partial refund succeeded with `status: "completed"`, and the `comments` tag came back exactly as sent. `meta.disburse_status` was `failed` in test mode, which is why the provider logs it.
- The hosted link Flutterwave issued pointed at `checkout-v2.dev-flutterwave.com`, which Cloudflare blocked from this network. The production host `checkout.flutterwave.com` did not recognise that test link. If your test link is blocked too, use a different network or ask Flutterwave support; the API side is unaffected.
- The public key and the secret key do **not** share their hash segment, so the public key is stored separately (`settings:flutterwavePublicKey`) and handed to the Inline client by create-session; it cannot be derived.

## Use

1. **Install** both packages:

   ```sh
   npm install @dashcommerce/core@^0.4.0 @dashcommerce/flutterwave
   ```

2. **Register the provider at runtime.** Import the package in a module the server loads before any request, such as `src/middleware.ts`:

   ```ts
   import "@dashcommerce/flutterwave"; // registers the "flutterwave" provider
   ```

   Importing it in `astro.config.mjs` is not enough: that file runs only at build time. Importing twice is harmless. If a different provider already holds the `flutterwave` id, the import throws instead of silently replacing it.

3. **Allow Flutterwave's API host:**

   ```ts
   emdash({ plugins: [dashcommerce({ allowedHosts: ["api.flutterwave.com"] })] });
   ```

4. **Choose Flutterwave and enter its keys** in Settings → Payment provider:

   | Field | Value |
   |---|---|
   | Secret key | Settings → API Keys. Test keys start `FLWSECK_TEST-`; live keys start `FLWSECK-` |
   | Secret hash | The secret hash you set under Settings → Webhooks. Flutterwave sends it back in `verif-hash` |
   | Public key | Settings → API Keys. Only for on-page checkout (Inline); test keys start `FLWPUBK_TEST-`, live keys `FLWPUBK-`. It is safe to expose to the browser |

   Save, then press **Test Flutterwave connection**. It makes one read-only call (`GET /v3/balances`) and says whether Flutterwave accepts the key, in test or live mode.

   Under **How customers pay**, choose hosted (Flutterwave's page) or on your page (Inline). On-page checkout refuses to start if the public key is not saved.

5. **For on-page checkout, load the browser client** in your checkout page's client script, so Vite bundles it:

   ```astro
   <script>
     import "@dashcommerce/flutterwave/checkout-client";
   </script>
   ```

   If your site sends a Content-Security-Policy, allow `https://checkout.flutterwave.com` for scripts and frames.

6. **Set the webhook URL** in the Flutterwave dashboard, including `?provider=flutterwave`:

   ```
   https://<your-site>/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=flutterwave
   ```

   Without the query, core picks the provider from the `verif-hash` header. That works today, but the query keeps Flutterwave's webhooks going to Flutterwave even if another provider later uses the same header. Enable **refund** webhooks as well, so `refund.updated` reaches the store.

7. **Use the same secret hash for every environment you point at the same site.** Flutterwave's dashboard has one webhook configuration; a test-mode delivery and a live-mode delivery both carry that value.

### Split payments

1. In DashCommerce → **Vendors**, add the vendor (or edit one) and open the Flutterwave payout account section.
2. Choose the country and bank, enter the account number, and press **Verify account**. Flutterwave returns the account holder's name; check it before continuing.
3. Fill in the business name, email and mobile (prefilled from the vendor), and choose the account's default split type and value. DashCommerce overrides this per payment with the exact vendor amount, so it is only the fallback for payments made outside DashCommerce.
4. Press **Create payout account**. The `RS_…` id, resolved name, bank and last four digits are stored on the vendor; the full account number is not.
5. If you already created the subaccount in Flutterwave, paste its `RS_…` id instead and set the status to **Active**.
6. Checkout computes each vendor's line subtotal minus the platform fee. Tax, shipping and platform-owned items stay with the platform. A vendor with no active account, a non-positive share, or a settlement currency that differs from the cart's blocks checkout with a readable 409.
7. Flutterwave's `flat_subaccount` pays each vendor that exact amount. Flutterwave's transaction fee and the NGN 50 stamp duty (over NGN 10,000) come out of the platform remainder, not the vendor shares. If the settlement is less than the sum of the vendor amounts, Flutterwave does not split that payment and sends the whole settlement to your main account — check the dashboard for those.

### Reconciliation

After a split payment, Flutterwave's verify response includes `meta.split_settlement_info`: what each subaccount actually earned and the platform's commission. The package parses it (with `app_fee`) into core's `splitSettlement`, and core stores it on the order as `providerSplits`, mapping each subaccount reference to its vendor. The admin order detail shows it under **Split settlement**. It records what Flutterwave settled; it never reprices the shares DashCommerce computed.

Refunding a split payment is different from a normal refund: Flutterwave can answer `400` with "Refund request successfully logged" and no refund id (seen in test mode). The package treats that as a failure so the order is not marked refunded. Check the Flutterwave dashboard and process the refund there.

Country-specific subaccount `meta` (SWIFT/routing/branch) is not collected by the form yet. The API accepts it for the US, Ghana, Tanzania, Rwanda, Uganda and SEPA countries; add it with the provider API until the form supports those countries.

## Develop

```sh
bun test           # unit tests, plus checkout → webhook → order → refund through core's real routes
bun run typecheck
bun run build
```

The integration tests use a Flutterwave stand-in that only answers verification for transactions it created, and that enforces the major/minor conversion in both directions. A provider that verifies by the wrong identifier or sends cents to Flutterwave fails there.

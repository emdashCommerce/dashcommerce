# Payments end-to-end test (manual, test mode)

**For:** the founder, before any PR to the fork's `main`, the upstream proposal, or any upstream PR.

**Branch:** `test/FIK-57-paystack-e2e`. It combines:
- FIK-58: core enablement, with provider cards in Settings.
- FIK-59: checkout follows the provider, plus on-page checkout.
- FIK-57: the Paystack package.
- The starter wired for both providers.

**Rules:** test keys only, no real money. Paste keys into the admin form yourself, never into chat, shell commands or files.

**Time:** about 90 minutes.

**Record results on the test-run page**, https://claude.ai/artifact/RDraJoGWMbourG3hu1u4XH. It has every step below, with pass/fail/blocked, order number, notes and screenshots (upload, or paste straight onto a step). Results save as you go, and Claude reads them back from there. Its source is `docs/testing/payments-test-run.html`. The [results sheet](#results-sheet) at the end is the same list on paper.

## 0. Before you start

| You need | Where |
|---|---|
| Stripe test keys: `sk_test_…` and `pk_test_…` | Stripe dashboard, test mode, Developers › API keys |
| Stripe CLI, logged in | `stripe login` (once) |
| Paystack test keys: `rk_test_…` (restricted, with `transactions:write` and `disputes_refunds:write`) or `sk_test_…` | Paystack dashboard, test mode, Settings › API Keys & Webhooks |
| Paystack webhook signing secret `whsec_…` (if your account has one) | Developers › API configuration |
| ngrok (installed) | `ngrok http …` |

## 1. Fresh store (terminal 1)

Start from an empty database, so you see the first-run experience:

```sh
cd ~/Projects/DashCommerce/.worktrees/FIK-57-paystack-e2e
git pull
npx bun@1.4.3 install
(cd packages/core && npx bun@1.4.3 run build) && (cd packages/paystack && npx bun@1.4.3 run build)
cd packages/starter
rm -f data.db data.db-shm data.db-wal
npx emdash init && node ../core/dist/cli/merge-seed.js && npx emdash seed --on-conflict=update
git checkout -- .emdash/seed.json emdash-env.d.ts   # generated files, keep the tree clean
SITE_URL=http://localhost:4321 npx astro dev --port 4321
```

Sign in at `http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`.

**Prices in KES:**
1. Open Products › **Design Templates**, which is digital, so it needs no shipping.
2. Add a KES price of 1,000.00 and publish.
3. In Settings › Store, enable KES and make it the default.

The seeded announcement bar says "Secure checkout powered by Stripe". That's demo content: edit it under Content › Announcements, or ignore it.

## 2. Webhooks (terminals 2 to 4)

```sh
# terminal 2: records every webhook (headers and raw body), then forwards it to :4321
cd ~/Projects/DashCommerce/.worktrees/FIK-57-paystack-e2e
node docs/testing/capture-webhooks.mjs

# terminal 3: Paystack reaches you through ngrok
ngrok http 4322

# terminal 4: Stripe forwards through the same capture proxy
stripe listen --forward-to localhost:4322/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=stripe
```

- **Stripe:** `stripe listen` prints a `whsec_…`. That's Stripe's webhook secret for step 3.
- **Paystack:** in the dashboard (test mode), set **Test Webhook URL** to `https://<ngrok-host>/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=paystack`.

## 3. Settings, first run

Open DashCommerce › **Settings**.

| # | Check | Expect |
|---|---|---|
| S1 | Look before choosing anything | "Payments aren't set up yet" warning. A **Payment provider** card shows Stripe and Paystack side by side, **neither selected**. No Stripe card, no Connect card |
| S2 | Click the Paystack card | Paystack is selected (blue border and tick). "How customers pay" appears (Hosted by Paystack / On your page), plus Paystack's two key fields |
| S3 | Type `pk_test_x` as the Paystack key and Save all | Refused, and the message lists the allowed prefixes |
| S4 | Enter your Paystack key and webhook secret, then Save all | Saved. Both fields show `••••` plus the last four characters |
| S5 | Click the Stripe card, enter `sk_test_…`, `pk_test_…` and the `whsec_…` from `stripe listen`, then Save all | Stripe is selected and the Stripe card appears with its keys. Saved and masked |
| S6 | Use only the keyboard: Tab to the provider cards and use the arrow keys | Focus is visible and the arrows change the selection |
| S7 | Do S1 to S2 again at 360px wide (browser devtools device mode) | The cards stack, and nothing needs sideways scrolling |

## 4. The four-way matrix

For each row:
1. In Settings, select the provider and its "How customers pay", then Save all.
2. In a private window, add **Design Templates** to the cart and go to `/checkout`.
3. Pay.
4. Check the order in admin › Orders.

| # | Provider | How customers pay | Pay with | Expect |
|---|---|---|---|---|
| M1 | Stripe | Hosted | Card `4242 4242 4242 4242`, any future date, any CVC | "Pay with Stripe →" sends you to Stripe. You come back to `/thank-you/…`, which shows the order. The order is **Paid**. Terminal 2 shows `checkout.session.completed` and the server answers 200 |
| M2 | Stripe | On your page | Same card | The card form shows on `/checkout` itself (Stripe Elements). The order is Paid |
| M3 | Paystack | Hosted | **M-Pesa** `+254 710 000 000` | `/checkout` asks for your details (email, name, phone, country) and the button reads "Pay with Paystack →". You go to Paystack and back. The order is Paid. Terminal 2 shows `charge.success` |
| M4 | Paystack | Hosted | **Card** `4084 0840 8408 4081`, CVV `408`, `11/27` | As M3 |
| M5 | Paystack | On your page | **M-Pesa** `+254 710 000 000` | Pressing Pay opens Paystack **over** your checkout; the URL doesn't change. After paying you land on `/thank-you/…`, and the order is Paid **only after** `charge.success` arrives |
| M6 | Paystack | On your page | Card `4084 0840 8408 4081` | As M5 |
| M7 | Paystack | On your page | Open the Popup, then close it without paying | "Payment not completed. You can try again." The Pay button works again, and no order exists |

**For M5 and M6, open devtools › Network, filter `paystack.co` and reload `/checkout`.** Nothing from `js.paystack.co` should load until you press Pay.

**Optional speed check:** in devtools › Performance, with Network set to "Fast 3G", record a reload of `/checkout` and note the LCP. The target is under 2 seconds.

## 5. Failures, Paystack (hosted or on-page, your choice; note which)

| # | Card | Expect |
|---|---|---|
| F1 | `4084 0800 0000 5408`, CVV `001` (declined) | No order. The customer can try again |
| F2 | `5078 5078 5078 5078 53`, CVV `082`, PIN `0000` (token not generated) | No order |
| F3 | `4084 0800 0067 0037`, CVV `787` (insufficient funds) | No order |

Note whether Paystack sent any webhook for these: terminal 2 prints one line per webhook.

## 6. Duplicate webhook

Replay M3's `charge.success` capture:

```sh
node docs/testing/capture-webhooks.mjs replay docs/testing/webhook-captures/<file>-charge.success.json
```

- **D1, within 5 minutes:** `200`, and still one order.
- **D2, after 5 minutes:** with a `whsec_` secret, a `400 … outside the 300-second window`. With an `sk_` secret, `200` and still one order.

## 7. Refunds (admin › Orders › open the order › Refund)

| # | Order | Action | Expect |
|---|---|---|---|
| R1 | M3 (Paystack M-Pesa) | Partial refund, KES 100 | Refund is **pending**. A `refund.*` webhook then moves it to **succeeded** |
| R2 | A new Paystack order paid with card `4084 0800 0067 1803`, CVV `180` | Full refund | Paystack fails it. Expect `refund.failed`, the refund marked **failed**, and an error in terminal 1 |
| R3 | A new Paystack order paid with card `4084 0800 0067 1902`, CVV `190` | Full refund | `refund.needs-attention`. The refund stays **pending** |
| R4 | M4 | Click Refund twice quickly, same amount | Record how many refunds Paystack shows. This is a known core gap |
| R5 | M1 (Stripe) | Partial refund | Refund succeeds at Stripe and the order shows Partially refunded |

**Open question for R1:** Paystack's docs show refund webhooks without a numeric `id`, but the package needs one. If R1 stays pending even though a `refund.processed` capture exists, that capture shows the real shape. It's a finding, not a test failure.

## 8. Switching provider

| # | Action | Expect |
|---|---|---|
| W1 | With Paystack active, refund the Stripe order M2 | Works, because Stripe's keys are kept. Settings shows "Stripe (not active)" |
| W2 | Resend an old Stripe webhook (`stripe events resend <evt_…>`) | Verified and accepted (200, a duplicate). Nothing breaks |

## 9. Dev admin survives checkout (FIK-61)

| # | Action | Expect |
|---|---|---|
| A4 | Stop the server, `rm -rf node_modules/.vite` in `packages/starter`, start it again. With DevTools "Disable cache" **off**, open the admin, then `/checkout` in another tab, then go back to the admin and open a few pages | The admin keeps working: no "Invalid hook call". Terminal 1 shows **no** "new dependencies optimized" line after the checkout visit |

## 10. Bring back

- This results sheet, filled in.
- Leave `docs/testing/webhook-captures/`; it's git-ignored. I'll read it locally, sanitise fixtures from it, and update the package to the real payloads.
- A screenshot of anything that looked wrong, at the width you saw it.

## Results sheet

| Step | Pass / fail | Order no. | Notes |
|---|---|---|---|
| S1 fresh store: nothing selected, warning | | | |
| S2 Paystack selected: styles and fields | | | |
| S3 `pk_` refused | | | |
| S4 Paystack keys saved, masked | | | |
| S5 Stripe keys saved, masked | | | |
| S6 keyboard and focus | | | |
| S7 360px | | | |
| M1 Stripe hosted | | | |
| M2 Stripe on-page | | | |
| M3 Paystack hosted, M-Pesa | | | |
| M4 Paystack hosted, card | | | |
| M5 Paystack on-page, M-Pesa | | | M-Pesa offered inside the Popup? |
| M6 Paystack on-page, card | | | |
| M7 Popup closed, no order | | | |
| `inline.js` only after Pay | | | |
| LCP on Fast 3G (optional) | | | __ s |
| F1 declined | | | Webhook sent? |
| F2 token not generated | | | Webhook sent? |
| F3 insufficient funds | | | Webhook sent? |
| D1 replay < 5 min | | | |
| D2 replay > 5 min | | | |
| R1 refund → succeeded | | | Refund webhook has an `id`? |
| R2 refund failed | | | |
| R3 needs attention | | | |
| R4 double click | | | How many refunds? |
| R5 Stripe refund | | | |
| W1 refund a Stripe order after switching | | | |
| W2 old Stripe webhook | | | |
| A4 dev admin survives a checkout visit | | | |
| Paystack headers on captures | | | `Paystack-Signature`, `x-paystack-signature`, or both? |
| Restricted `rk_` key worked for checkout and refunds | | | |

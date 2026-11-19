# Paystack end-to-end test (manual, test mode)

For: the founder, before the C2 proposal or any upstream PR. Branch `test/FIK-57-paystack-e2e`: core enablement (FIK-58) + `@dashcommerce/paystack` (FIK-57) + starter wiring. Test keys only. No real money.

**Time:** about 45 minutes. **Record** each result in the checklist at the end.

## 0. Before you start

- **Keys** (yours, from the Paystack dashboard in **test mode**):
  - **Secret key:** `sk_test_…`, or better the restricted `rk_test_…` with `transactions:write` and `disputes_refunds:write`.
  - **Webhook signing secret:** `whsec_…` (Developers → API configuration → Webhook signing secret). If there is none yet, use the `sk_test_` key.
  - Paste them into the admin form yourself. Don't put them in chat, shell commands or files.
- **Tools:** `ngrok` (installed), or Cloudflare's `cloudflared tunnel --url …`.

## 1. Start the site (terminal 1)

```sh
cd ~/Projects/DashCommerce/.worktrees/FIK-57-paystack-e2e
npx bun@1.4.3 install
(cd packages/core && npx bun@1.4.3 run build) && (cd packages/paystack && npx bun@1.4.3 run build)
cd packages/starter
SITE_URL=http://localhost:4321 npx astro dev --port 4321
```

The worktree's `data.db` is already seeded, and its Paystack settings hold **fake** keys. You'll replace them in step 3.

## 2. Webhooks: capture proxy and tunnel (terminals 2 and 3)

```sh
# terminal 2: saves every webhook (all headers, raw body) and forwards it to :4321
cd ~/Projects/DashCommerce/.worktrees/FIK-57-paystack-e2e
node docs/testing/capture-webhooks.mjs

# terminal 3
ngrok http 4322
```

In the Paystack dashboard (test mode), Settings → API Keys & Webhooks → **Test Webhook URL**:

```
https://<your-ngrok-host>/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=paystack
```

Your browser uses `http://localhost:4321` directly. Only Paystack goes through the tunnel.

## 3. Configure the shop

1. **Sign in:** open `http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/dashcommerce/settings`.
2. **Payment provider card:**
   - Provider: **Paystack**.
   - Paste your secret or restricted key and your webhook secret.
   - Click **Save all**.
   - Check: both fields now show `••••` plus the last four characters. A `pk_` key must be refused.
3. **Store:** enabled currencies include **KES**, and the default is **KES**.
4. **A KES price:** in Products, open **Design Templates** (digital, so no shipping) and add a KES price of **1,000.00**. Publish.

## 4. Payments

For each payment: add Design Templates to the cart, check out with your own email, pay on Paystack's page, and come back to `/thank-you/…`.

| # | How to pay | Expect |
|---|---|---|
| P1 | **M-Pesa** `+254 710 000 000` | Order **Paid** in admin → Orders; a `charge.success` capture; thank-you page shows the order |
| P2 | **Card** `4084 0840 8408 4081`, CVV `408`, expiry `11/27` | Same as P1 |
| F1 | Card `4084 0800 0000 5408`, CVV `001` (declined) | No order; cart draft stays unpaid |
| F2 | Card `5078 5078 5078 5078 53`, CVV `082`, PIN `0000` (token not generated) | No order |
| F3 | Card `4084 0800 0067 0037`, CVV `787` (insufficient funds) | No order |

For F1 to F3, note whether Paystack sent any webhook (the capture terminal prints one line per webhook).

## 5. Duplicate webhook

Take P1's `charge.success` capture from `docs/testing/webhook-captures/`:

```sh
node docs/testing/capture-webhooks.mjs replay docs/testing/webhook-captures/<file>-charge.success.json
```

- **Within 5 minutes** of the original: expect `200` and still **one** order.
- **After 5 minutes**, with a `whsec_` secret: expect `400 … outside the 300-second window`. With an `sk_` secret: `200`, still one order.

## 6. Refunds (admin → Orders → open the order → Refund)

| # | Order | Action | Expect |
|---|---|---|---|
| R1 | P1 (M-Pesa) | Partial refund, KES 100 | Refund row **pending**; then a `refund.*` webhook moves it to **succeeded** |
| R2 | New order paid with card `4084 0800 0067 1803`, CVV `180` | Full refund | Paystack fails the refund. Expect `refund.failed`, the refund marked **failed**, and an error in terminal 1's log |
| R3 | New order paid with card `4084 0800 0067 1902`, CVV `190` | Full refund | `refund.needs-attention`; the refund stays **pending** |
| R4 | P2 (card) | Click **Refund** twice quickly, same amount | Record how many refunds Paystack shows. This is the known core gap: each click makes a new idempotency key |

**Open question:** Paystack's docs show refund webhooks with only `refund_reference`. The package needs a numeric `id`. If R1 stays pending although a `refund.processed` capture exists, the capture tells us the real shape, and that's a finding, not a failed test.

## 7. Bring back

- The checklist below, filled in.
- Leave `docs/testing/webhook-captures/` in place (it's git-ignored). I'll read it locally, sanitise fixtures from it, and update the package to the real `charge.success` and `refund.*` payloads and headers.
- Say whether the captures carry `Paystack-Signature`, `x-paystack-signature`, or both.

## Checklist

| Step | Result | Notes |
|---|---|---|
| 3 Keys saved and masked; `pk_` refused | | |
| P1 M-Pesa order paid | | |
| P2 card order paid | | |
| F1 declined → no order | | |
| F2 token not generated → no order | | |
| F3 insufficient funds → no order | | |
| 5 replay within 5 min → one order | | |
| 5 replay after 5 min | | |
| R1 refund → succeeded | | |
| R2 refund failed → failed + error log | | |
| R3 needs attention → pending | | |
| R4 double click → how many refunds | | |
| Headers on captures | | |

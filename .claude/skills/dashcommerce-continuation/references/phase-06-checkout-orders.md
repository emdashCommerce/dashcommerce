# Phase 6 — Checkout + Orders + Refunds + Inventory + Cron

**The critical payment path.** After this phase a merchant can accept a real (test-mode) Stripe payment end-to-end: cart → PaymentIntent → confirm → webhook → order persisted → stock decremented → receipt.

## Files to create

```
packages/core/src/
├── cart/lock.ts                      # stock soft-lock CRUD (KV prefix lock:)
├── stripe/refunds.ts                 # createRefund / listRefunds
├── orders/
│   ├── create.ts                     # idempotent from paid PaymentIntent
│   ├── status.ts                     # state machine transitions
│   ├── refund.ts                     # full/partial; Stripe refund; inventory restore
│   └── receipt.ts                    # compose + ctx.email.send()
├── inventory/
│   ├── decrement.ts                  # on order paid
│   ├── restore.ts                    # on refund or cancel
│   └── ledger.ts                     # audit trail put
├── routes/
│   ├── checkout.ts                   # POST /checkout/create-intent
│   └── webhook.ts                    # POST /checkout/webhook (public, sig-verified)
└── hooks/cron.ts                     # cron handler: lock sweep every 5 min
```

Also wire into `src/sandbox-entry.ts`:
- Add `"cron"` hook (calls the sweeper).
- Add `checkout.ts` + `webhook.ts` routes.
- Schedule cron via `plugin:install` (to be expanded in phase 17).

## `cart/lock.ts`

KV key: `lock:{orderDraftId}`. Value is `StockLock` from `types.ts`.

```ts
export async function createLock(ctx, lock: StockLock): Promise<void>
export async function getLock(ctx, orderDraftId: string): Promise<StockLock | null>
export async function deleteLock(ctx, orderDraftId: string): Promise<void>
export async function sumActiveLocksForProduct(ctx, productId, variantId?): Promise<number>
  // scan KV lock:* via ctx.kv.list("lock:") — emdash returns { key, value } list
export async function sweepExpiredLocks(ctx): Promise<number>
  // list all lock:*, delete those with expiresAt < now
```

TTL is 15 minutes by default — set `expiresAt` in `createLock` at `now + 15min`.

## `orders/create.ts`

```ts
export async function createOrderFromPaymentIntent(
  ctx: PluginContext,
  pi: StripePaymentIntent,
  cartSnapshot: CartState,
): Promise<Order>
```

**Critical:** unique-index on `stripePaymentIntentId`. Catch the conflict → return the existing order. This is how we return 200 on duplicate webhooks.

Sequence:
1. Check `orders.query({ where: { stripePaymentIntentId: pi.id }, limit: 1 })` — if exists, return it.
2. Upsert `customers` by email (search by unique email index; create if missing).
3. Generate `orderNumber` from a monotonic counter in KV (`counter:orderNumber`, `ctx.kv.get` + 1 + `set`).
4. Batch-put order + order items via `putMany`.
5. Decrement stock (see `inventory/decrement.ts`) — capture new levels.
6. Write `inventory_ledger` entries per item.
7. Release stock locks for this orderDraftId.
8. Increment coupon usage per applied coupon (put into `coupon_usage`, increment `coupons[code].usageCount`).
9. If any item has `isDigital` + `downloadableFiles`, create `download_grants` (phase 8).
10. If any item has `subscriptionConfig`, spawn subscription creation (phase 7).
11. Trigger receipt email (swallow errors if no provider — log warning).

Use `ulid()` from `emdash` for ids where possible.

## `orders/refund.ts`

```ts
export async function refundOrder(
  ctx: PluginContext,
  orderId: string,
  amount: Money,           // if equal to order.total, full; else partial
  reason?: string,
  lineItemRefunds?: Array<{ orderItemId: string; quantity: number; amount: Money }>,
): Promise<Refund>
```

Sequence:
1. Load order.
2. Call `stripe/refunds.ts createRefund({ payment_intent: order.stripePaymentIntentId, amount })`.
3. Put a `refunds` row with `stripeRefundId` (unique-indexed).
4. If `lineItemRefunds` + `restock` flag present: restore stock via `inventory/restore.ts` + ledger.
5. Update order status:
   - If sum(refunds.amount) >= order.total → `refunded`, paymentStatus `refunded`.
   - Else → `partially-refunded`, paymentStatus `partially-refunded`.
6. Update `refundedTotal` on order.
7. Send refund email.

## `routes/checkout.ts` (public)

POST `/checkout/create-intent`

1. Load cart from session cookie.
2. Re-validate each line against current product/variant prices **in cart.currency**. Reject on mismatch or unavailability.
3. Check stock against product/variant `stockQuantity` minus `sumActiveLocksForProduct` for each line.
4. Compute pricing policy (`taxMode`) from settings. For `stripe_tax`, call Stripe Tax Calculations API (new: `stripe/tax.ts`) and add those lines to the cart.
5. Compute vendor splits (phase 10) if Connect enabled.
6. Generate `orderDraftId = ulid()`. Create stock locks for each line.
7. `stripe/payment-intents.createPaymentIntent({ amount: cart.total.amount, currency: cart.currency.toLowerCase(), receipt_email: cart.customerEmail, metadata: { orderDraftId, sessionId: cart.sessionId }, transfer_data?, application_fee_amount? })`.
8. Persist the cart snapshot to KV at `draft:{orderDraftId}` (TTL 15 min) — webhook needs this.
9. Return `{ clientSecret, orderDraftId }`.

## `routes/webhook.ts` (public, sig-verified)

POST `/checkout/webhook`

1. Read raw body (do NOT parse yet — HMAC is over bytes).
2. Read `Stripe-Signature` header.
3. Read `settings:stripeWebhookSecret` from KV.
4. `verifyStripeSignature` — reject 400 on fail.
5. Now parse JSON, get `event.type`.
6. Switch:
   - `payment_intent.succeeded` → load cart snapshot by `pi.metadata.orderDraftId` → `createOrderFromPaymentIntent(pi, snapshot)`.
   - `payment_intent.payment_failed` → release locks; keep cart (user can retry).
   - `payment_intent.canceled` → release locks.
   - `charge.refunded` / `refund.updated` → refundOrder path (look up order by `pi.id`).
   - `customer.subscription.*`, `invoice.*` → subscription handlers (phase 7).
   - Anything else → return 200 (ignore).
7. Return 200.

## `inventory/decrement.ts`

```ts
export async function decrementForOrderItem(
  ctx: PluginContext,
  orderItem: OrderItem,
): Promise<{ newStock: number | null }>
```

- If `variantId` present → `products/variants.adjustVariantStock(ctx, variantId, -qty)`.
- Else → load product content, decrement `data.stockQuantity` by qty (if `manageStock`), `ctx.content.update("products", productId, { data: updated })`.
- Write ledger entry via `inventory/ledger.ts`.
- If `newStock < lowStockThreshold` AND `belowThresholdAt` was null → set `belowThresholdAt = now` on product (low-stock alert trigger).

## `hooks/cron.ts`

```ts
export const cronHandler: CronHandler = async (event, ctx) => {
  if (event.name === "sweep-stock-locks") {
    const swept = await sweepExpiredLocks(ctx);
    ctx.log.info(`Swept ${swept} expired stock locks`);
  }
  // more: abandoned-cart recovery (phase 11), dunning retry (phase 7)
};
```

Schedule from `plugin:install` (phase 17):
```ts
await ctx.cron?.schedule("sweep-stock-locks", { schedule: "*/5 * * * *" });
```

## Verification

```sh
cd /Users/timuzua/Dev/dashcommerce/packages/core
bun run typecheck
bun run build
```

Then manually against the starter (once phase 19 lands) or the user's POC:
1. Add product, add to cart.
2. POST to `/checkout/create-intent` — verify `clientSecret` returned.
3. `stripe listen --forward-to localhost:4321/_emdash/api/plugins/dashcommerce/checkout/webhook`
4. `stripe trigger payment_intent.succeeded` with metadata `{ orderDraftId }`.
5. Check `ctx.storage.orders` has the row.
6. Check product stock decreased.
7. Check `ctx.storage.inventory_ledger` has the audit entry.

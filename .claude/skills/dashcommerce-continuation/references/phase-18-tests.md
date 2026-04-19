# Phase 18 — Tests

Using `bun test`. All tests live in `packages/core/test/` and import from `../src/*`.

## Coverage target

| Module | Test file | Key scenarios |
|---|---|---|
| `money.ts` | `money.test.ts` | add/sub/mul/percent correctness on USD (2-decimal), JPY (0-decimal), BHD (3-decimal); mixed-currency throws; format/parse round-trip |
| `cart/calculate.ts` | `cart-calculate.test.ts` | subtotal with multiple items; percent + fixed coupon discount; free-shipping threshold edge; tax applies to shipping when configured; multi-currency cart refuses mixed lines |
| `coupons/validate.ts` | `coupons.test.ts` | expired, inactive, min/max, includedProductIds match, excludedCategories block, usageLimit reached, per-customer limit, individualUse; resolveDiscount for all 5 types |
| `shipping/calculate.ts` | `shipping.test.ts` | zone matching by country/region; all 4 method types; free-shipping with coupon override; weight-based sums qty × weight |
| `tax/calculate.ts` | `tax.test.ts` | table selection by country+region+postal prefix+class+priority; compound tax math |
| `stripe/client.ts` | `stripe-client.test.ts` | encodeStripeForm handles nested + arrays; HTTP error wraps `StripeApiError`; Idempotency-Key passed through |
| `stripe/webhook-verify.ts` | `stripe-webhook-verify.test.ts` | **Published Stripe test vector passes**; wrong secret fails; tampered payload fails; expired timestamp fails; multi-v1 rotation accepts any |
| `orders/create.ts` | `orders-create.test.ts` | idempotent on duplicate PaymentIntent (returns existing order); coupon usage increments once; stock decrements once; inventory_ledger gains one entry |
| `orders/refund.ts` | `orders-refund.test.ts` | full → `refunded`; partial → `partially-refunded`; stock restored when requested; Stripe refund call happens before persist |
| `products/pricing.ts` | `pricing.test.ts` | variant override beats product; missing currency returns null; compareAt propagates |
| `cart/lock.ts` | `locks.test.ts` | sumActiveLocksForProduct excludes expired; sweep removes expired |
| `inventory/decrement.ts` | `inventory.test.ts` | variant path decrements variant stock; non-variant path decrements product content; below-threshold sets belowThresholdAt once |
| `downloads/tokens.ts` | `downloads.test.ts` | token verify accepts valid, rejects tampered, rejects expired |
| `subscriptions/lifecycle.ts` | `subscriptions.test.ts` | status transitions consistent with Stripe events |
| `vendors/split.ts` | `vendors.test.ts` | platform fee percent rounds correctly; single-vendor cart uses transfer_data; multi-vendor uses multi-PI |

## Stripe webhook test vector

From Stripe's own docs — check https://stripe.com/docs/webhooks/signatures for the canonical "example" payload. Bake it into `stripe-webhook-verify.test.ts` as a known-good case:

```ts
import { describe, test, expect } from "bun:test";
import { verifyStripeSignature } from "../src/stripe/webhook-verify";

// Example from Stripe docs (replace with current example if Stripe updates it).
const payload = '{"id":"evt_test","object":"event"}';
const secret = "whsec_test_secret";
const timestamp = 1492774577;
// signature = HMAC-SHA256(secret, `${timestamp}.${payload}`) as hex
// Pre-compute once and hardcode for the test.
const sig = "<hex>";
const header = `t=${timestamp},v1=${sig}`;

test("accepts valid signature", async () => {
  const result = await verifyStripeSignature({
    payload, signatureHeader: header, secret,
    now: timestamp * 1000, toleranceSeconds: 300,
  });
  expect(result.ok).toBe(true);
});
```

If no known vector is handy, compute one inline once and freeze it.

## Mocking `ctx`

Create a test helper `test/helpers/fake-ctx.ts` that builds a `PluginContext`-shaped object with in-memory storage + kv:

```ts
export function makeCtx(): PluginContext {
  const storages: Record<string, Map<string, unknown>> = {};
  function storage(name: string) {
    const map = storages[name] ??= new Map();
    return {
      get: async (id) => map.get(id) ?? null,
      put: async (id, data) => { map.set(id, data); },
      delete: async (id) => map.delete(id),
      exists: async (id) => map.has(id),
      getMany: async (ids) => new Map(ids.filter(i => map.has(i)).map(i => [i, map.get(i)])),
      putMany: async (items) => { for (const i of items) map.set(i.id, i.data); },
      deleteMany: async (ids) => ids.reduce((n, i) => n + (map.delete(i) ? 1 : 0), 0),
      query: async ({ where, limit = 50 }) => {
        let items = [...map.entries()].map(([id, data]) => ({ id, data }));
        if (where) items = items.filter(r => matchWhere(r.data, where));
        return { items: items.slice(0, limit), cursor: undefined, hasMore: false };
      },
      count: async (where) => {
        if (!where) return map.size;
        return [...map.values()].filter(v => matchWhere(v, where)).length;
      },
    };
  }
  const kv = new Map<string, unknown>();
  return {
    plugin: { id: "dashcommerce", version: "0.0.0" },
    storage: new Proxy({}, { get: (_, name) => storage(String(name)) }),
    kv: {
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k),
      list: async (prefix) => [...kv.entries()].filter(([k]) => k.startsWith(prefix ?? "")).map(([k, v]) => ({ key: k, value: v })),
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as PluginContext;
}
```

This lets 90% of tests run without touching a database.

## Bun test config

Add to `packages/core/package.json`:
```json
"test": "bun test"
```
(already present)

## CI

`.github/workflows/ci.yml` already runs `bun run test` with `continue-on-error: true`. Drop that after phase 18 lands.

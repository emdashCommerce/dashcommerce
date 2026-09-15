# Shipping Zone P1 Fix Summary

## Issue
**Ship-blocker P1**: Demo checkout at https://demo.dashcommerce.dev rejects US ZIP codes 10001 (New York) and 90210 (California) with "We don't ship to that location yet." Stripe payment stays disabled.

## Root Cause

The install hook (`packages/core/src/hooks/install.ts`) created a default shipping zone with an **empty locations array**:

```typescript
// OLD (BROKEN)
await store.put("default", {
  id: "default",
  name: "Default zone",
  locations: [],  // ❌ Empty array matches NO addresses
  order: 0,
});
```

The `matchesZone()` function in `packages/core/src/shipping/calculate.ts` returns `false` for any address when `locations` is empty:

```typescript
export function matchesZone(address: Address, zone: ShippingZone): boolean {
  for (const loc of zone.locations) {  // Never runs when locations: []
    if (loc.country !== address.country) continue;
    if (!loc.regions || loc.regions.length === 0) return true;
    if (loc.regions.includes(address.region)) return true;
  }
  return false;  // Always returns false when locations: []
}
```

## Fix

Updated `ensureDefaultShippingZone()` to:

1. Create a **US-wide shipping zone** with `locations: [{ country: 'US' }]`
2. Create a **default flat-rate shipping method** ($5 Standard Shipping)

```typescript
// NEW (FIXED)
await zonesStore.put("us-domestic", {
  id: "us-domestic",
  name: "United States (Domestic)",
  locations: [{ country: "US" }],  // ✅ Matches all US addresses
  order: 0,
});

await methodsStore.put("us-flat-rate", {
  id: "us-flat-rate",
  zoneId: "us-domestic",
  title: "Standard Shipping",
  type: "flat_rate",
  enabled: true,
  config: {
    type: "flat_rate",
    amount: { currency: "USD", amount: 500 },
  },
  order: 0,
});
```

## Verification

### Test Results
- ✅ All 92 tests pass (including 7 new shipping zone tests)
- ✅ Typecheck clean
- ✅ Build succeeds

### Specific P1 Cases

| Address | Old Behavior | New Behavior |
|---------|-------------|--------------|
| US, NY, 10001 | ❌ NO MATCH | ✅ MATCH |
| US, CA, 90210 | ❌ NO MATCH | ✅ MATCH |
| US, TX, 75001 | ❌ NO MATCH | ✅ MATCH |
| CA, ON, M5H 2N2 | ❌ NO MATCH | ❌ NO MATCH (correct) |

### How to Verify Locally

1. **Fresh install**:
   ```bash
   bun emdash seed  # Will create us-domestic zone + us-flat-rate method
   bun dev
   ```

2. **Test checkout**:
   - Add a physical product to cart
   - Go to checkout
   - Enter US address (10001 or 90210)
   - Expected: "Standard Shipping - $5.00" appears
   - Expected: Stripe payment becomes enabled

3. **Run tests**:
   ```bash
   bun test packages/core/test/shipping-zones.test.ts
   ```

## Live Demo Impact

The existing Railway/Neon deployment has the old broken zone. After merge:

### Option 1: Redeploy (Recommended)
```bash
git pull origin main
# Redeploy on Railway
```
**Note**: Install hook will skip (zone already exists). Need manual fix.

### Option 2: Manual SQL Fix
```sql
-- Update existing zone
UPDATE shipping_zones 
SET locations = '[{"country":"US"}]'::jsonb,
    name = 'United States (Domestic)',
    updated_at = NOW()
WHERE id = 'default';

-- Create shipping method if missing
INSERT INTO shipping_methods (
  id, zone_id, title, type, enabled, config, "order", created_at, updated_at
) VALUES (
  'us-flat-rate', 
  'default', 
  'Standard Shipping', 
  'flat_rate', 
  true, 
  '{"type":"flat_rate","amount":{"currency":"USD","amount":500}}'::jsonb,
  0, 
  NOW(), 
  NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Option 3: Admin UI (if shipping admin is deployed)
1. Go to DashCommerce → Shipping
2. Edit "Default zone" → Add location: US (all regions)
3. Add method: Flat Rate, $5.00

## Files Changed

- `packages/core/src/hooks/install.ts` — Updated `ensureDefaultShippingZone()`
- `packages/core/test/shipping-zones.test.ts` — New test file (7 tests)

## PR

**Draft PR**: https://github.com/emdashCommerce/dashcommerce/pull/30  
**Branch**: `cursor/fix-shipping-zones-p1-4a9e`

## Success Criteria

✅ Draft PR created  
✅ Root cause documented  
✅ Fix verified with tests  
✅ Common US zip codes (10001, 90210) now work  
✅ Starter/demo stores ship to typical US addresses out of the box  
✅ Live demo fix documented (redeploy + manual seed steps)

## Notes

- Did NOT touch Orders admin (separate P0 being handled by another agent)
- Did NOT publish to npm
- Did NOT merge (draft PR as requested)
- Fix is backward-compatible: existing installs with custom zones unaffected
- New installs get proper US zone + method automatically

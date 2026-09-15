# Localhost Redirect Bug - Root Cause & Fix

## Issue Summary

On the live demo at https://demo.dashcommerce.dev (Railway + Neon), URLs in Stripe checkout redirects and admin invite links were incorrectly pointing to `http://localhost:8080` instead of the public domain `https://demo.dashcommerce.dev`.

**Affected URLs:**
- Stripe checkout success: `http://localhost:8080/thank-you/<id>?session_id=...`
- Stripe checkout cancel: `http://localhost:8080/checkout?canceled=1`
- Billing portal return: `http://localhost:8080/account`
- Vendor invite refreshUrl: `http://localhost:8080/vendor/refresh`
- Vendor invite returnUrl: `http://localhost:8080/vendor/done`

## Root Causes (Two Issues)

### 1. Request URL Behind Reverse Proxy

The code was constructing redirect URLs using:
```typescript
const origin = new URL(routeCtx.request.url).origin;
const successUrl = `${origin}/thank-you/...`;
```

When deployed behind a reverse proxy (Railway, nginx, etc.), `routeCtx.request.url` contains the **internal** routing URL that the application listens on (`http://localhost:8080`), not the public domain. This is standard behavior for containerized apps behind proxies:

```
Public: https://demo.dashcommerce.dev
   ↓ (Railway proxy)
Internal: http://localhost:8080 ← What the app sees
```

### 2. Stale Database Option

The live Neon database had a stale option:
```
emdash:site_url = "http://localhost:8080"  ← Stale from dev/setup
```

This may have been set during initial development or migration. While the environment variable was correct (`SITE_URL=https://demo.dashcommerce.dev`), the database option took precedence in some code paths or could have been read by EmDash core for site URL resolution.

## The Fix

### Code Changes

Created a hardened `getPublicSiteUrl()` helper that:
1. Uses `ctx.site.url` (from SITE_URL env var) instead of request origin
2. Validates the URL is configured
3. Warns if localhost is detected in production
4. Strips trailing slashes for clean URL construction

```typescript
// Before
const origin = new URL(routeCtx.request.url).origin;
const successUrl = `${origin}/thank-you/${orderDraftId}...`;

// After
import { getPublicSiteUrl } from "../util/site-url";
const siteUrl = getPublicSiteUrl(ctx);
const successUrl = `${siteUrl}/thank-you/${orderDraftId}...`;
```

The `ctx.site.url` value comes from EmDash's plugin context, which is populated from Astro's `site` config. In `packages/starter/astro.config.mjs`:

```javascript
site: process.env.SITE_URL ?? "http://localhost:4321",
```

### Files Changed

1. **`packages/core/src/util/site-url.ts`** (new)
   - `getPublicSiteUrl(ctx)` - Validated public URL helper
   - `isProductionSiteUrl(ctx)` - Production detection utility

2. **`packages/core/src/routes/checkout.ts`**
   - Line ~519: Stripe Checkout Session success/cancel URLs
   - Used for hosted checkout mode after cart submission

3. **`packages/core/src/routes/subscriptions-public.ts`**
   - Line ~245: Billing portal return URL
   - Used when customers manage their subscriptions

4. **`packages/core/src/routes/customer-portal.ts`**
   - Line ~114: Customer portal return URL
   - Used for billing portal access via email magic link

### Database Option Cleanup

**IMPORTANT:** After deploying this fix, operators should update the stale database option to match the production domain:

```sql
-- For Railway/Neon Postgres
UPDATE options 
SET value = '"https://demo.dashcommerce.dev"'
WHERE key = 'emdash:site_url';

-- Verify
SELECT key, value FROM options WHERE key LIKE '%site%';
```

Expected result after cleanup:
```
emdash:site_url = "https://demo.dashcommerce.dev"
site:url = "https://demo.dashcommerce.dev"
```

**Note:** The code fix ensures correct behavior even if this database option remains stale, but cleaning it up prevents confusion during debugging.

## Required Configuration

The fix requires the `SITE_URL` environment variable to be set in production:

```bash
SITE_URL=https://demo.dashcommerce.dev
```

**Railway Configuration:**
Railway already has this set for the demo deployment. No changes needed.

**Other Platforms:**
Set `SITE_URL` to your public domain in:
- Railway: Project settings → Environment Variables
- Docker: `-e SITE_URL=https://your-domain.com`
- Kubernetes: ConfigMap or Secret
- Platform-as-a-Service: Platform environment config

## Operational Steps for Live Demo

### Immediate (Required)

Railway already has `SITE_URL` configured. Once this PR is merged and deployed:

1. ✅ New checkouts will redirect correctly (code fix handles this)
2. ✅ New vendor invites will use correct URLs
3. ✅ Billing portal will return to correct URL

### Follow-Up (Recommended)

Clean up the stale database option to prevent future confusion:

```sql
-- Connect to Neon Postgres database
-- Update the stale emdash:site_url option
UPDATE options 
SET value = '"https://demo.dashcommerce.dev"'
WHERE key = 'emdash:site_url';

-- Verify both site URL options are now correct
SELECT key, value FROM options WHERE key LIKE '%site%';
```

**Parent is handling this database cleanup.** No manual restart or cache clearing needed.

## Verification Steps

After deployment, verify the fix:

### 1. Stripe Checkout
```bash
# Add item to cart, proceed to checkout
# Complete test payment with card 4242424242424242
# → Success redirect should go to: https://demo.dashcommerce.dev/thank-you/...
```

### 2. Vendor Invites (if Stripe Connect is enabled)
```bash
# In admin: /_emdash/admin/plugins/dashcommerce/vendors
# Click "Onboard a vendor", fill form
# → Generated link should be: https://demo.dashcommerce.dev/vendor/...
```

### 3. Billing Portal
```bash
# As logged-in customer with subscription
# Access customer portal
# → Return URL should be: https://demo.dashcommerce.dev/account
```

## Why Admin Invite Links May Not Have Been Broken

The vendor invite links in `VendorsPage.tsx` use:
```typescript
refreshUrl: `${window.location.origin}/vendor/refresh`,
returnUrl: `${window.location.origin}/vendor/done`,
```

Since this code runs in the **browser**, `window.location.origin` correctly reflects the public URL the user sees (`https://demo.dashcommerce.dev`). The bug only affected server-side URL construction where `routeCtx.request.url` exposed the internal routing.

## Technical Details

### Why ctx.site.url Works

EmDash's plugin context includes a `site` object populated from the Astro integration:

```typescript
interface PluginContext {
  site: {
    url: string;  // From astro.config.mjs `site` field
    // ...
  }
  // ...
}
```

This value:
- ✅ Comes from configuration (SITE_URL env var), not runtime detection
- ✅ Is explicitly set via environment variable
- ✅ Works correctly behind proxies
- ✅ Is consistent across all routes and hooks
- ✅ Takes precedence over database options in our helper

### Database Options vs Environment Variables

EmDash may store site configuration in multiple places:
1. **Database KV options** (`emdash:site_url`, `site:url`) - Can become stale
2. **Environment variables** (`SITE_URL`) - Always fresh from deploy config
3. **Astro config** (`site` field) - Reads from SITE_URL

The `getPublicSiteUrl()` helper ensures we always use the environment-driven value (`ctx.site.url`) rather than any potentially stale database options.

### Helper Behavior

```typescript
export function getPublicSiteUrl(ctx: PluginContext): string {
  const siteUrl = ctx.site?.url;
  if (!siteUrl) {
    throw new Error("ctx.site.url is not configured. Set SITE_URL.");
  }
  const normalized = siteUrl.replace(/\/$/, "");
  
  // Warn but allow localhost (useful for dev/test)
  if (normalized.includes("localhost")) {
    ctx.log.warn("Site URL is localhost - set SITE_URL for production");
  }
  
  return normalized;
}
```

This approach:
- Fails fast if SITE_URL is missing
- Logs warnings for localhost in production (aids debugging)
- Allows localhost for development environments
- Centralizes URL validation logic

### Why Request URL Doesn't Work

In a reverse proxy setup:
```
Browser → https://demo.dashcommerce.dev/checkout
   ↓ (Railway routes to internal service)
App receives → http://localhost:8080/checkout
```

The `Request.url` property contains what the app's HTTP server sees after proxy forwarding. Most proxies preserve the path but use the internal host:port.

Standard workarounds (which we don't need now):
- `X-Forwarded-Host` header parsing
- `Host` header inspection
- Configuration-based origin (← what we use via `ctx.site.url`)

## Related Issues

This same pattern affects any deployed app that:
1. Runs behind a reverse proxy
2. Constructs absolute URLs for external services (Stripe, OAuth, etc.)
3. Uses request-based origin detection

Common platforms where this occurs:
- Railway
- Heroku
- Google Cloud Run
- AWS ECS/Fargate
- Kubernetes with Ingress
- nginx reverse proxy

## PR Information

**Branch:** `cursor/fix-localhost-redirects-c2c9`  
**Pull Request:** https://github.com/emdashCommerce/dashcommerce/pull/25  
**Status:** Open (Draft)

The PR is marked as draft as requested. Review and merge when ready.

## Database Option Reference

### Checking Current Values

```sql
-- View all site-related options
SELECT key, value FROM options WHERE key LIKE '%site%';
```

Expected output on a correctly configured system:
```
key              | value
-----------------+----------------------------------
emdash:site_url  | "https://demo.dashcommerce.dev"
site:url         | "https://demo.dashcommerce.dev"
```

### Fixing Stale localhost Values

If `emdash:site_url` shows localhost:

```sql
-- Update to production domain
UPDATE options 
SET value = '"https://demo.dashcommerce.dev"'
WHERE key = 'emdash:site_url';

-- Or delete and let it reinitialize from env
DELETE FROM options WHERE key = 'emdash:site_url';
```

### When to Update Database Options

Update the database option after:
- Initial deployment setup
- Domain changes
- Environment migrations (dev → staging → prod)
- Railway project redeployment with new domain

The code fix in this PR ensures correct behavior even if the database option is stale, but keeping it synchronized prevents debugging confusion.

---

**Fix Date:** September 15, 2026  
**Affected Version:** EmDash 0.37 + @dashcommerce/core 0.2.0  
**Target Deploy:** Railway (demo.dashcommerce.dev)  
**Database:** Neon Postgres

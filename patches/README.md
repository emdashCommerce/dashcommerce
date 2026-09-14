# EmDash Patch Required for DashCommerce

This directory contains patches that must be applied to EmDash for DashCommerce to function correctly.

## Why Patches Are Required

DashCommerce requires two fixes to EmDash's plugin route handling:

### 1. Request Body Cloning (`request.clone().json()`)

EmDash's `parseRouteInput()` calls `request.json()` directly, consuming the request body. This breaks Stripe webhook signature verification, which needs to read the raw body using `request.text()`.

**Fix**: Change `request.json()` to `request.clone().json()` so the body can be read multiple times.

### 2. Raw Response Passthrough

EmDash wraps all plugin route responses in `apiSuccess()`, which serializes Response objects to `{}`. DashCommerce's webhook handlers return raw Response objects with `200 OK` status required by Stripe.

**Fix**: Check if `result.data instanceof Response` and return it directly without wrapping.

## Applying the Patch

### Option 1: Using Bun (Recommended)

```bash
# Add to package.json:
{
  "patchedDependencies": {
    "emdash@0.37.0": "patches/emdash@0.37.0.patch"
  }
}

# Then run:
bun install
```

### Option 2: Using pnpm

```bash
# Add to package.json:
{
  "pnpm": {
    "patchedDependencies": {
      "emdash@0.37.0": "patches/emdash@0.37.0.patch"
    }
  }
}

# Then run:
pnpm install
```

### Option 3: Using patch-package (npm/yarn)

```bash
# Install patch-package:
npm install -D patch-package

# Add to package.json scripts:
{
  "scripts": {
    "postinstall": "patch-package"
  }
}

# Copy the patch file to your project root:
cp node_modules/@dashcommerce/core/patches/emdash@0.37.0.patch patches/

# Run:
npm install
```

## Verification

After applying the patch, verify it worked:

```bash
# Check for the patched functions:
grep "request.clone().json()" node_modules/emdash/dist/menus-*.mjs
grep "instanceof Response" node_modules/emdash/dist/astro/routes/api/plugins/_pluginId_/_...path_.mjs
```

Both should return matches. If not, the patch was not applied.

## Upstream Status

These fixes have been proposed upstream. Track progress:
- Request cloning: [Needed for webhook signature verification]
- Response passthrough: [Needed for webhook 200 responses and redirects]

Once these land in EmDash, this patch will no longer be required and will be removed in a future DashCommerce release.

## What Breaks Without the Patch?

- **Stripe webhooks fail** - Signature verification throws "Body already consumed"
- **Webhook responses return `{}`** - Stripe sees empty JSON instead of 200 OK
- **Some redirects don't work** - Response objects are serialized instead of returned

If you see any of these issues, the patch is not applied correctly.

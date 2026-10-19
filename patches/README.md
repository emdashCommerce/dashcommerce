# EmDash Patch Required for DashCommerce

This directory contains patches that must be applied to EmDash for DashCommerce to function correctly.

Patches are version-exact (Bun `patchedDependencies` keys include the resolved version). We currently ship:

| EmDash | Patch |
|---|---|
| 0.37.0 | `patches/emdash@0.37.0.patch` |
| 1.1.0 | `patches/emdash@1.1.0.patch` |
| 1.2.0 | `patches/emdash@1.2.0.patch` |
| 1.3.0 | `patches/emdash@1.3.0.patch` |
| 1.3.1 | `patches/emdash@1.3.1.patch` |

Patches target hashed dist filenames, so they only apply to that exact version. Every EmDash release renames these chunks, patch releases included (1.3.0 to 1.3.1 renamed `routes-*` and `http-route-dispatch-*`), so `emdash@1.3.2` will not pick up the 1.3.1 patch. When the installed EmDash is in the supported range but has no shipped patch, DashCommerce prints a loud warning in the dev/build terminal (from `dashcommerce()` in `astro.config`) and again at plugin init.

The package manager applies the matching file for the version you installed.

## Why Patches Are Required

DashCommerce requires two fixes to EmDash's plugin route handling:

### 1. Request Body Cloning (`request.clone().json()`)

EmDash's `parseRouteInput()` calls `request.json()` directly, consuming the request body. This breaks Stripe webhook signature verification, which needs to read the raw body using `request.clone().text()` (EmDash 1.x also guards `ctx.request.text()` after parse).

**Fix**: Change `request.json()` to `request.clone().json()` so the original body can still be cloned.

On 0.37 this lives in a hashed `dist/menus-*.mjs` chunk. On 1.1 through 1.3.x it lives in `dist/routes-*.mjs` (the hash changes per version).

### 2. Raw Response Passthrough

EmDash wraps plugin route responses in `apiSuccess()`, which serializes Response objects to `{}`. DashCommerce handlers return raw Response objects (cart `Set-Cookie`, webhook `200`, redirects).

EmDash 1.x's official `response: "raw"` path is **not** a substitute: it requires `pluginResponse()` and strips `Set-Cookie` through a header allowlist.

**Fix**: If `result.data` duck-types as a Web `Response` (`status`, `clone`, `headers.get`), return it directly. Do not use `instanceof Response` — that fails across realms. Do not set `response: "raw"` on DashCommerce routes: that field is missing on EmDash 0.37 and the official 1.x raw path strips `Set-Cookie`.

On 0.37 this is in the plugin Astro route module. On 1.1 through 1.3.x dispatch lives in `dist/http-route-dispatch-*.mjs` (hashed per version).

## Applying the Patch

### Option 1: Using Bun (Recommended)

```bash
# Add to package.json:
{
  "patchedDependencies": {
    "emdash@0.37.0": "patches/emdash@0.37.0.patch",
    "emdash@1.1.0": "patches/emdash@1.1.0.patch",
    "emdash@1.2.0": "patches/emdash@1.2.0.patch",
    "emdash@1.3.0": "patches/emdash@1.3.0.patch",
    "emdash@1.3.1": "patches/emdash@1.3.1.patch"
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
      "emdash@0.37.0": "patches/emdash@0.37.0.patch",
      "emdash@1.1.0": "patches/emdash@1.1.0.patch",
      "emdash@1.2.0": "patches/emdash@1.2.0.patch",
      "emdash@1.3.0": "patches/emdash@1.3.0.patch",
      "emdash@1.3.1": "patches/emdash@1.3.1.patch"
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

# Copy the patch that matches your installed EmDash version:
cp node_modules/@dashcommerce/core/patches/emdash@0.37.0.patch patches/
cp node_modules/@dashcommerce/core/patches/emdash@1.1.0.patch patches/
cp node_modules/@dashcommerce/core/patches/emdash@1.2.0.patch patches/
cp node_modules/@dashcommerce/core/patches/emdash@1.3.0.patch patches/
cp node_modules/@dashcommerce/core/patches/emdash@1.3.1.patch patches/

# Run:
npm install
```

## Verification

After applying the patch, verify it worked:

```bash
# 0.37.x
grep "request.clone().json()" node_modules/emdash/dist/menus-*.mjs
grep "result.data.clone" node_modules/emdash/dist/astro/routes/api/plugins/_pluginId_/_...path_.mjs

# 1.1.x / 1.2.x / 1.3.x
grep "request.clone().json()" node_modules/emdash/dist/routes-*.mjs
grep "result.data.clone" node_modules/emdash/dist/http-route-dispatch-*.mjs
```

Both should return matches. If not, the patch was not applied.

## Upstream Status

These fixes have been proposed upstream. Track progress:
- Request cloning: [Needed for webhook signature verification]
- Response passthrough: [Needed for webhook 200 responses, cookies, and redirects]

Once these land in EmDash, this patch will no longer be required and will be removed in a future DashCommerce release.

## What Breaks Without the Patch?

- **Stripe webhooks fail** - Signature verification throws "Body already consumed" (or EmDash 1.x's `ctx.request.text()` guard)
- **Webhook responses return `{}`** - Stripe sees empty JSON instead of 200 OK
- **Cart session cookies don't stick** - `Set-Cookie` is dropped when Response objects are serialized
- **Some redirects don't work** - Response objects are serialized instead of returned

If you see any of these issues, the patch is not applied correctly.

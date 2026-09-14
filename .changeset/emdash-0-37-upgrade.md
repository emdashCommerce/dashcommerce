---
"@dashcommerce/core": minor
---

Upgrade to EmDash 0.37.0 with comprehensive auto-update safety system.

**Breaking Change**: Minimum EmDash version is now `0.37.0` (peer dependency updated from `>=0.28.0 <0.29.0` to `>=0.37.0 <0.38.0`). This is a breaking change for consumers on EmDash 0.28-0.36.

**EmDash 0.37 Upgrade**:
- All EmDash dependencies upgraded from 0.28.x to 0.37.0 across the monorepo
- Ported EmDash patch for request.clone().json() and Response passthrough to 0.37.0 structure
- Fixed Node.js build by externalizing Cloudflare Workers runtime modules (`cloudflare:sockets`, etc.) that EmDash 0.37 imports conditionally

**Auto-Update Safety System** (prevents silent breakage on future EmDash updates):
1. **Runtime Compatibility Check**: New `version-check.ts` module validates EmDash version at plugin initialization, providing clear error messages when version is incompatible
2. **Renovate Configuration**: Auto-merges EmDash patch/minor updates when CI passes; requires manual review for major versions
3. **CI Compatibility Matrix**: Tests DashCommerce against all supported EmDash versions in parallel

**Supported EmDash Range**: This release supports `0.37.0 <= version < 0.38.0`. Future EmDash updates will be gated by CI and runtime compatibility checks.

All typechecks, builds, and tests pass on EmDash 0.37.0.

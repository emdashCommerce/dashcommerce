# EmDash patches used by this repo

These are the EmDash patches this monorepo applies to its own installs, through
`patchedDependencies` in the root `package.json`:

| EmDash | Patch | Used by |
|---|---|---|
| 1.3.1 | `patches/emdash@1.3.1.patch` | `packages/lite`, `packages/registry-setup` (dev) |
| 1.5.0 | `patches/emdash@1.5.0.patch` | `packages/core` (dev), `packages/starter` |

The sync-starter workflow copies this folder into the flat starter repo.

Patches only apply to the exact EmDash version in their filename. When the repo
moves to a new EmDash version, add the new patch here and remove the old one.

## Patches for sites running DashCommerce

`@dashcommerce/core` ships a patch for every EmDash version it supports, in
`node_modules/@dashcommerce/core/patches/`. What they fix, how to apply them
with Bun, pnpm or patch-package, and how to check they applied are all in
[`packages/core/patches/README.md`](../packages/core/patches/README.md).

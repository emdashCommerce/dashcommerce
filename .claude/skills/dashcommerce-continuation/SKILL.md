---
name: dashcommerce-continuation
description: Pick up work on the DashCommerce EmDash plugin where the last session stopped. Use when the user asks to continue, resume, pick up, or implement any remaining phase of dashcommerce.
---

# Continuing DashCommerce

DashCommerce is a WooCommerce-equivalent commerce plugin for EmDash CMS, being built to feature parity (not MVP). See `/Users/timuzua/Dev/dashcommerce/RESUME.md` for the full status and architecture invariants — **read it first, always.**

## When invoked

1. **Read `RESUME.md` cover-to-cover.** It contains every architectural invariant, the list of what's done, and the sequence of remaining phases.
2. Run `cd /Users/timuzua/Dev/dashcommerce && git log --oneline -5` to see the latest commit.
3. Ask the user which phase to tackle next, or infer from `git log` + the table in `RESUME.md`.
4. Load the matching reference file from this skill's `references/` directory:
   - `phase-06-checkout-orders.md` — checkout route + orders + refunds + inventory + cron
   - `phase-12-admin-react-ui.md` — the 12 admin pages + 5 widgets
   - `phase-13-storefront.md` — Astro components + Stripe Elements islands
   - `phase-18-tests.md` — the full test suite layout
   - `phase-other.md` — compact blueprints for phases 7–11, 14–17, 19
5. Build the phase. **One phase = one commit.** Commit message format: `feat: phase N — <what>`.

## Non-negotiables

These come from `RESUME.md` but are load-bearing enough to repeat:

- **No Node built-ins** in `sandbox-entry.ts`'s import graph. Use `crypto.subtle`, `ctx.http.fetch`, `URLSearchParams`, `TextEncoder`.
- **Money** is always `{ currency, amount }` with integer minor units. Cross-currency arithmetic throws.
- **Idempotency** on every Stripe webhook via unique-index dedup. Return 200 on duplicates.
- **Sandbox signature verification before side effects.** No exceptions.
- **Cart re-priced server-side at checkout.** Never trust client-sent prices.
- **ISO 8601 timestamps everywhere.**
- **`PluginDescriptor.storage` uses flat `string[]` indexes**, not composite tuples (that shape is runtime-only).
- **`where` clauses accept `string | number | boolean | null | RangeFilter | InFilter | StartsWithFilter`.** Type accordingly.

## How the hybrid plugin format works here

- `src/index.ts` returns a `PluginDescriptor` with `format: "native"`, `entrypoint: "@dashcommerce/core/sandbox"`, `adminEntry: "@dashcommerce/core/admin"`, `componentsEntry: "@dashcommerce/core/astro"`.
- `src/sandbox-entry.ts` uses `definePlugin({ hooks, routes })` — the standard shape (no id/version). EmDash reads `format` from the descriptor to decide how to load it.
- `src/admin/entry.tsx` exports `pages` and `widgets` maps consumed by emdash's admin shell.
- `src/astro/index.ts` exports `blockComponents` for Portable Text renderers.

## How to test a running build against a real emdash site

1. `cd /Users/timuzua/Dev/dashcommerce/packages/core && bun run build`
2. `cd /Users/timuzua/Dev/poc/new-wp-node` (or the starter once phase 19 lands)
3. `bun add /Users/timuzua/Dev/dashcommerce/packages/core` (local tarball install, not symlink — symlinks confuse emdash's bundler)
4. Add to `astro.config.mjs`: `import { dashcommerce } from "@dashcommerce/core";` + include in `plugins: [...]`
5. Paste `defineProductsCollection()` output into `seed.json` under `collections`
6. `bun emdash seed && bun dev`
7. For webhooks: `stripe listen --forward-to localhost:4321/_emdash/api/plugins/dashcommerce/checkout/webhook`

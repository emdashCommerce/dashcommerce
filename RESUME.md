# DashCommerce — Resume Guide

**For a future Claude session (or anyone) picking up where we stopped.**

Original plan: `/Users/timuzua/.claude/plans/glimmering-painting-fog.md` — approved by the user and frozen except for scope creep from the user themselves.

Current repo: `/Users/timuzua/Dev/dashcommerce` (branch `main`).

## Progress snapshot

| Phase | Commit | State |
|---|---|---|
| 1–5 | `098823f` | scaffold: types, money, storage, sandbox entry, cart routes |
| 6   | `b5c93ed` | checkout + orders + refunds + inventory + cron |
| 7   | `f2ae40e` | subscriptions + dunning + self-service |
| 8   | `56db64e` | digital downloads (signed token URLs) |
| 9   | `34436fe` | reviews + moderation + summary aggregation |
| 10  | `d9361b9` | Stripe Connect (Express onboarding + single-vendor split + payouts) |
| 11  | `6ccce80` | abandoned-cart cron + restore token |
| 12  | **todo** | admin React UI (12 pages + 5 widgets) — see "Phase 12 reconnaissance" below |
| 13–19 | **todo** | storefront Astro, portable text, email templates, reports, install hook, tests, starter |

All commits typecheck clean (`bun run typecheck`) and build clean (`bun run build` from `packages/core`). No Node built-ins in the sandbox import graph.

---

## What this project is

**DashCommerce** — a WooCommerce-equivalent commerce plugin for [EmDash CMS](https://github.com/emdash-cms/emdash), built to ride the wave of EmDash's (Cloudflare's Astro-based WordPress successor) launch and ~10k GitHub stars in <1 month.

The user's direction was explicit: **no MVP, no deferred tranche — ship everything WooCommerce has, in v1.0.** Products (all 5 types including subscriptions + digital downloads), multi-currency from day one, cart, Stripe checkout, orders admin with refunds, customers, coupons, multi-zone shipping, Stripe Tax optional, inventory, reviews, subscriptions via Stripe Subscriptions, Stripe Connect multi-vendor, abandoned-cart recovery, transactional emails, React admin UI that later ports to Block Kit for marketplace distribution.

---

## What's done (commit `098823f`, phases 1–5 of 19)

All typed, typechecks clean (`bun run typecheck`), builds clean (`bun run build`), sandbox-safe.

```
packages/core/src/
├── index.ts                     # native descriptor factory + re-exports
├── sandbox-entry.ts             # definePlugin({ hooks, routes }) — wired to content hook + cart routes
├── storage-collections.ts       # 19 plugin storage collections w/ indexes + uniqueIndexes
├── money.ts                     # Money type + arithmetic + format/parse; currency-safe; no floats
├── types.ts                     # full entity type surface (~470 LoC)
├── seed/products-collection.ts  # defineProductsCollection() helper for host seed.json
├── hooks/content.ts             # content:beforeSave product field validation
├── products/
│   ├── types.ts                 # purchasability + shipping predicates
│   ├── pricing.ts               # resolvePrice({ product, variant?, currency })
│   └── variants.ts              # variant CRUD against ctx.storage.product_variants
├── cart/
│   ├── store.ts                 # KV CRUD (cart:{sessionId})
│   └── calculate.ts             # subtotal → discount → shipping → tax → total pipeline (pure)
├── coupons/validate.ts          # validateCoupon + resolveDiscount (all 5 discount types)
├── shipping/calculate.ts        # flat / free / pickup / weight-based rate options per zone
├── tax/calculate.ts             # tax table engine (multi-rate, compound support)
├── stripe/
│   ├── client.ts                # ctx.http.fetch wrapper; urlencoded; Idempotency-Key; Connect header
│   ├── payment-intents.ts       # createPaymentIntent + retrievePaymentIntent
│   └── webhook-verify.ts        # verifyStripeSignature via crypto.subtle (Web Crypto)
├── routes/cart.ts               # public: GET /cart, POST /cart/items, /cart/currency, /cart/shipping-address
├── admin/entry.tsx              # React admin entry stub — empty pages + widgets maps
└── astro/index.ts               # blockComponents export stub
```

Infrastructure:
- `package.json` (monorepo root + workspaces), `tsconfig.base.json`, `biome.json`, `.gitignore`, `LICENSE` (MIT), `README.md`, `CHANGELOG.md`
- `.github/workflows/ci.yml` — typecheck + build + test
- `packages/core/tsdown.config.ts` — ESM build with `.d.ts`, neutral platform

---

## Phase 12 resolution

The emdash install ships a `creating-plugins` skill at
`/Users/timuzua/Dev/poc/new-wp-node/.agents/skills/creating-plugins/references/admin-ui.md`
that is the authoritative source. It documents:

- `usePluginAPI()` from `@emdash-cms/admin` — auto-prefixes plugin id on paths
- primitives `Card`, `Button`, `Input`, `Select`, `Toggle`, `Table`,
  `Loading`, `Alert` exported from `@emdash-cms/admin`
- `pages` + `widgets` maps as the admin entry exports
- pages mount at `/_emdash/admin/plugins/<plugin-id>/<path>`

The installed `@emdash-cms/admin@0.4.0` in the POC lags the skill (those
symbols aren't yet in the compiled `index.d.ts`), but the skill is the
target API. Phase 12 is written against it using
`src/admin/emdash-admin.d.ts` — an ambient declaration that augments
`@emdash-cms/admin` with the skill's documented surface so this package
typechecks today and binds to the real exports on a newer host.

## What's next (phases 6–19)

See `.claude/skills/dashcommerce-continuation/SKILL.md` for the orchestration skill, and the per-phase reference files in that directory for blueprints.

High-level sequence:

| Phase | Focus | Status |
|---|---|---|
| 6 | **Checkout + orders + refunds + inventory + cron** (the critical payment path) | ✅ `b5c93ed` |
| 7 | Subscriptions | ✅ `f2ae40e` |
| 8 | Digital downloads | ✅ `56db64e` |
| 9 | Reviews | ✅ `34436fe` |
| 10 | Stripe Connect | ✅ `d9361b9` (single-vendor split; multi-vendor returns 501 with clear error) |
| 11 | Abandoned cart recovery | ✅ `6ccce80` |
| 17 | Install hook + onboarding DX | ✅ `05f902b` (shipped early; unblocks cron scheduling + secret rotation) |
| 18 | Tests | ✅ `d4dc83c` (66 tests, 7 files — Money, cart, coupons, webhook, status, tokens, split) |
| 12 | Admin React UI | ✅ (current commit) — 12 pages, 5 widgets, admin-api.ts, ambient d.ts for @emdash-cms/admin |
| 16 | Reports | ✅ (rolled into phase 12 — `admin-api.ts` has revenue/top-products/top-customers/mrr) |
| 13 | Storefront Astro components + Stripe Elements islands | pending |
| 14 | Portable Text blocks | pending |
| 15 | Transactional email templates | pending (plain-text receipts already wired from phase 6/7/11) |
| 19 | Starter example + screenshots + npm publish | pending |

---

## Immutable architectural rules (re-derived in every session)

1. **No Node built-ins** in `sandbox-entry.ts` or anything it transitively imports. Crypto via `crypto.subtle`. HTTP via `ctx.http.fetch`. No `require`, no `fs`, no `path`, no `node:*`. This keeps the port to standard format mechanical.
2. **All money as `Money` (integer minor units + ISO 4217 currency)**. Arithmetic via `money.ts` helpers only. Mixed-currency ops throw `CurrencyMismatchError`.
3. **Idempotency** on every Stripe webhook via unique-index dedup on `stripePaymentIntentId`, `stripeRefundId`, `stripeInvoiceId`, `stripePayoutId`. Always return HTTP 200 on duplicates.
4. **No transactions across collections.** Use `putMany` for atomic batches (e.g. order + order_items). Sequence multi-collection writes so partial failure is recoverable and cron can re-drive.
5. **Webhook signature verification MUST happen before any side effect.** 400 on fail. See `stripe/webhook-verify.ts`.
6. **Cart must be re-priced server-side at checkout.** Never trust client-sent prices. Re-resolve using `products/pricing.ts` in cart currency against current product/variant data.
7. **ISO 8601 timestamps** for all dates — string-compare for index ordering.
8. **Products live on the host content collection** (`products`), declared via `defineProductsCollection()` in seed.json. Plugins cannot declare content collections. Commerce-specific data lives on the content item's `data` object, validated in `hooks/content.ts`.
9. **Variants, orders, customers, coupons, shipping, subscriptions, reviews, vendors, inventory_ledger, download_grants → plugin storage.** 19 collections declared in `storage-collections.ts`.
10. **Carts + stock soft-locks → KV** (prefixes `cart:` and `lock:`). Cron sweeps expired locks every 5 min.
11. **Native plugin format** now, Block Kit port later. Current descriptor has `format: "native"`, `adminEntry`, `componentsEntry`. `definePlugin({})` in sandbox-entry is the standard shape (no id/version); emdash reads `format` from the descriptor.
12. **Low-stock alerts fire once** per product per below-threshold crossing. Track `belowThresholdAt` on product fields; reset on restock.

---

## Dev loop

```sh
cd /Users/timuzua/Dev/dashcommerce
bun install
bun run typecheck       # tsc --noEmit across workspaces
bun run build           # tsdown for core
bun test                # phase 18+ only
```

From `packages/core` specifically:
```sh
cd packages/core
bun run typecheck
bun run build
bun run dev             # tsdown --watch
```

Once phase 19's starter exists, the full loop is:
```sh
cd packages/starter
bun install
bun emdash seed
bun dev                 # Astro at :4321
stripe listen --forward-to localhost:4321/_emdash/api/plugins/dashcommerce/checkout/webhook
```

---

## Critical references

Reference emdash install at `/Users/timuzua/Dev/poc/new-wp-node` (the user's POC site — has `emdash@0.4.0` + `@emdash-cms/plugin-audit-log` — we use these node_modules as our type + pattern reference).

| What | Where | Notes |
|---|---|---|
| `PluginDescriptor` interface | `node_modules/emdash/dist/index-CRg3PWfZ.d.mts` lines 2175–2231 | Descriptor shape — `format`, `adminEntry`, `adminPages`, `adminWidgets`, `capabilities`, `allowedHosts`, `storage`, `componentsEntry` |
| `StorageCollectionDeclaration` (descriptor) | Same file lines 2178–2181 | Only `indexes: string[]` + `uniqueIndexes?: string[]` — **no composite tuples at descriptor level** |
| `StorageCollectionConfig` (runtime) | `node_modules/emdash/dist/types-BYWYxLcp.d.mts` lines 112–124 | `Array<string \| string[]>` — composites allowed at runtime |
| `WhereValue`, `RangeFilter`, `InFilter`, `StartsWithFilter` | Same file lines 132–147 | Legal `where` clause values |
| `StorageCollection<T>` API | Same file, search for `interface StorageCollection` | `get/put/query/count/putMany/deleteMany`; `query` returns `{ items: [{id, data}], cursor, hasMore }` |
| `KVAccess`, `PluginContext`, hook types | Same file | Used throughout |
| Audit-log plugin (standard-format reference) | `node_modules/@emdash-cms/plugin-audit-log/dist/sandbox-entry.mjs` | Read patterns for hooks + routes |
| WooCommerce source (feature-map reference) | `/Users/timuzua/Dev/poc/new-wp-node/woocommerce/` | PHP source — useful for scoping edges on coupons, order states, shipping |

---

## Pitfalls (learned the hard way)

- **PluginDescriptor uses `adminEntry`, not `admin.entry`.** The creating-plugins skill docs show a nested `admin: {entry, pages, widgets}` shape — that's wrong for the descriptor. Flat fields: `adminEntry`, `adminPages`, `adminWidgets`, `componentsEntry`.
- **Composite indexes don't compile at descriptor level.** `PluginDescriptor.storage[*].indexes` is `string[]` only. If you need composite queries, handle them at the app layer with compound `where`.
- **`where` clauses don't accept `Record<string, unknown>`.** Values must be `string | number | boolean | null | RangeFilter | InFilter | StartsWithFilter`. Type the where object accordingly.
- **Stripe webhook verify must use Web Crypto**, not Node's `crypto.createHmac`. If you see `import { createHmac } from "crypto"` anywhere in `sandbox-entry.ts`'s import graph, stop and fix it — it will break in the sandbox port.
- **`definePlugin({})` with no id/version returns `StandardPluginDefinition`.** That's fine for the hybrid path — the descriptor's `format: "native"` + `entrypoint: "@dashcommerce/core/sandbox"` tells emdash how to load it.
- **tsdown emits `.js` + `.d.ts`**, not `.mjs` + `.d.mts`, when package.json has `type: "module"`. Our exports match this.

---

## How to resume in a future session

1. Open this file.
2. `cd /Users/timuzua/Dev/dashcommerce && git log --oneline -5` to confirm the last commit.
3. Run `bun install && bun run typecheck && bun run build` to confirm the tree still compiles.
4. Load the continuation skill: `/skill dashcommerce-continuation` (if available), OR read `.claude/skills/dashcommerce-continuation/SKILL.md` manually.
5. Pick the next unchecked phase from the table above.
6. Read the matching reference file in `.claude/skills/dashcommerce-continuation/references/`.
7. Write code. Typecheck after each file. Build before committing.
8. One commit per phase, in the format: `feat: phase N — <what>`.

The user's tolerance for partial work is low — they want things that run, not stubs. Prefer completing fewer phases well over scaffolding many badly.

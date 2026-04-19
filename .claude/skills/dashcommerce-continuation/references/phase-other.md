# Phases 7–11, 14–17, 19 — Compact Blueprints

One-page-each blueprints for the remaining phases that don't have a dedicated reference file. Each describes: files to create, key functions, and the non-obvious traps.

---

## Phase 7 — Subscriptions

### Files

```
packages/core/src/
├── stripe/subscriptions.ts              # Stripe API: createSubscription, cancelSubscription, updateSubscription, listInvoices
├── subscriptions/
│   ├── create.ts                        # called from webhook on customer.subscription.created
│   ├── lifecycle.ts                     # cancel (immediate / end-of-period), pause, resume, change plan
│   └── dunning.ts                       # on invoice.payment_failed: log, email, mark past_due
└── routes/subscriptions-public.ts       # customer self-service via signed token
```

### Key decisions

- Products of type `subscription` must have `subscriptionConfig: { interval, intervalCount, trialDays? }` — validated in `hooks/content.ts` already.
- On successful checkout for a subscription product, we create the Stripe Subscription in `orders/create.ts`'s post-processing step (not at PaymentIntent time — Stripe handles subscription-first via SetupIntent, but for MVP we do subscription-after-one-off: first period is the initial PaymentIntent; subsequent invoices auto-renew via Stripe Subscriptions).
- Alternative cleaner path: Use Stripe's **SubscriptionSchedule** or **Checkout Sessions (mode=subscription)** — but those bypass our PaymentIntent flow. Decide before writing code.
- Webhook events to handle:
  - `customer.subscription.created` → upsert into `subscriptions` (unique-index on `stripeSubscriptionId`).
  - `customer.subscription.updated` → update status, periods, cancelAtPeriodEnd.
  - `customer.subscription.deleted` → set status `canceled`.
  - `invoice.payment_succeeded` → put `subscription_invoices` row, update `currentPeriodStart/End`.
  - `invoice.payment_failed` → put `subscription_invoices` row, trigger dunning email. Stripe handles retry; we just watch.

### Customer self-service

`routes/subscriptions-public.ts` uses a signed short-TTL token (Web Crypto HMAC) as the auth mechanism. Email the link at order time. Endpoints:
- `POST /subscriptions/:id/cancel` (immediate | at_period_end)
- `POST /subscriptions/:id/pause` (map to Stripe `pause_collection`)
- `POST /subscriptions/:id/resume`

---

## Phase 8 — Digital downloads

### Files

```
packages/core/src/
├── downloads/
│   ├── grant.ts                         # on paid order with digital items → create download_grants rows
│   ├── tokens.ts                        # signed URL: HMAC over { grantId, fileIndex, exp }
│   └── serve.ts                         # route handler — verify, increment usesCount, stream or redirect
└── routes/downloads.ts                  # GET /downloads/:token
```

### Signing

Use Web Crypto HMAC-SHA256 with a 32-byte secret stored in KV under `state:downloadSigningSecret`. Rotate on `plugin:install`. Token format:

```
base64url(JSON.stringify({ g: grantId, f: fileIndex, e: expMs })).sig=base64url(hmac)
```

…or compact: `${grantId}.${fileIndex}.${expMs}.${hex(hmac)}` if JSON feels heavy.

### Serving

If `grant.mediaId`, redirect to `ctx.media` signed upload URL (emdash provides this). If `grant.externalUrl`, redirect to it. Either way, increment `usesCount` atomically (read → check < maxUses → write).

### Grant expiry & max uses

From settings: `downloadTokenTtlHours` (default 24), `downloadMaxUses` (default 3). Per-file.

---

## Phase 9 — Reviews

### Files

```
packages/core/src/
├── reviews/
│   ├── store.ts                         # CRUD helpers against ctx.storage.reviews
│   └── moderate.ts                      # approve/reject/spam; aggregate into review_summaries
└── routes/reviews-public.ts             # POST /reviews (submit), GET /reviews/:productId
```

### Public submit flow

Anti-spam at MVP: require `reviewsRequireApproval` (default true); auto-set status `pending`. Optionally require `reviewsRequirePurchase` (check customer has a paid order containing the product).

### Aggregates

On approval, recompute `review_summaries[productId] = { averageRating, count, distribution }` and put it. Read from this on product card render (fast), not via live aggregate.

### Admin

`ReviewsPage.tsx` (phase 12) shows the moderation queue, with approve/reject/spam buttons calling `admin/reviews/:id/moderate`.

---

## Phase 10 — Stripe Connect

### Files

```
packages/core/src/
├── stripe/connect.ts                    # createAccount, createAccountLink, retrieveAccount, listPayouts
├── vendors/
│   ├── onboarding.ts                    # start flow: create account + account link → returns onboarding URL
│   ├── payouts.ts                       # sync from Stripe API
│   └── split.ts                         # given cart → compute per-vendor PaymentIntent plan
```

### Split model

For v1.0: **one PaymentIntent per vendor group**. If cart has items from 1 vendor → single PI with `transfer_data: { destination }` + `application_fee_amount`. If multiple vendors → create N PIs, each with its own client_secret; frontend confirms each. Cart snapshot KV entry holds the orderDraftIds array so the webhook aggregator can finalize when all succeed.

### Platform fee

Global default from setting `connectPlatformFeePercent`. Per-vendor override via `vendors[vendorId].platformFeePercent`. Computed on each vendor's line subtotal (not grand total).

### Webhooks

Add to `webhook.ts`:
- `account.updated` → update vendor record (`onboardingStatus`, `chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`).
- `payout.paid` / `payout.failed` → upsert `vendor_payouts` row.

---

## Phase 11 — Abandoned cart recovery

### Files

```
packages/core/src/abandoned-cart/recover.ts
```

### Behavior

Hourly cron job:
1. `ctx.kv.list("cart:")` — iterate.
2. For each cart with `customerEmail` + no `abandonedEmailSentAt` + `updatedAt` older than `settings:abandonedCartDelayHours` (default 4):
   - Send reminder email with a signed cart-restore URL: `/cart/restore/:token` (token signs sessionId + exp 7 days).
   - Set `abandonedEmailSentAt = now` on the cart.

### Restore route

`POST /cart/restore/:token` — verify token, rewrite the `dashcommerce_sid` cookie to the cart's sessionId, redirect to `/cart`.

### Add to `hooks/cron.ts`

```ts
if (event.name === "abandoned-cart-scan") {
  const swept = await recoverAbandoned(ctx);
  ctx.log.info(`Sent ${swept} abandoned cart emails`);
}
```

Schedule in `plugin:install`:
```ts
await ctx.cron?.schedule("abandoned-cart-scan", { schedule: "0 * * * *" });
```

---

## Phase 14 — Portable Text blocks

### Files

```
packages/core/src/astro/
├── ProductEmbedBlock.astro              # props: Astro.props.node.product (slug)
├── ProductGridBlock.astro               # props: category slug + limit
└── ReviewQuoteBlock.astro               # props: reviewId
```

### Descriptor update

Add `portableTextBlocks` to `src/index.ts` descriptor:

```ts
portableTextBlocks: [
  {
    type: "product-embed",
    label: "Embed Product",
    icon: "package",
    fields: [
      { type: "text_input", action_id: "product_slug", label: "Product slug" },
    ],
  },
  {
    type: "product-grid",
    label: "Product Grid",
    icon: "grid",
    fields: [
      { type: "text_input", action_id: "category_slug", label: "Category slug" },
      { type: "number_input", action_id: "limit", label: "Max items", initial_value: "6" },
    ],
  },
  {
    type: "review-quote",
    label: "Review Quote",
    icon: "message-circle",
    fields: [{ type: "text_input", action_id: "review_id", label: "Review id" }],
  },
],
```

Check the exact `PortableTextBlockField` shape in `node_modules/emdash/dist/types-BYWYxLcp.d.mts`.

### Astro side

`src/astro/index.ts`:

```ts
import ProductEmbedBlock from "./ProductEmbedBlock.astro";
import ProductGridBlock from "./ProductGridBlock.astro";
import ReviewQuoteBlock from "./ReviewQuoteBlock.astro";

export const blockComponents = {
  "product-embed": ProductEmbedBlock,
  "product-grid": ProductGridBlock,
  "review-quote": ReviewQuoteBlock,
};
```

---

## Phase 15 — Transactional email templates

### Files

```
packages/core/src/emails/
├── receipt.ts                   # order paid
├── refund.ts
├── abandoned-cart.ts
├── subscription-renewed.ts
├── subscription-failed.ts       # dunning
├── review-request.ts            # on order fulfilled
├── vendor-onboarding.ts
├── vendor-payout.ts
└── templates/
    ├── receipt.txt
    ├── receipt.html
    └── …                        # one .txt and one .html per event
```

### Shape

Each email module exports `compose(...)` returning `{ subject, text, html }` and a `send(ctx, ...)` that calls `ctx.email.send(...)`. Swallow errors when no provider is configured (log warning).

### Templating

No mustache. Use template literals — the email set is small and the shapes are known. Inline `format(money, locale)` and `order.orderNumber` directly.

---

## Phase 16 — Reports

### Admin page

`ReportsPage.tsx` (part of phase 12's file set). Backend endpoints in `routes/admin-api.ts`:

- `admin/reports/revenue?from&to&groupBy=day|week|month&currency=XXX`
- `admin/reports/top-products?from&to&limit=10`
- `admin/reports/top-customers?from&to&limit=10`
- `admin/reports/coupons?from&to`
- `admin/reports/mrr?asOf`
- `admin/reports/vendor-payouts?from&to`

Each aggregates via `ctx.storage.orders.query` with date-range filters + in-memory grouping. No OLAP engine — at commerce-plugin scale this is fine up to ~100k orders; can move to materialized rollups later.

### Multi-currency

Revenue is always bucketed per currency. Display as a stacked bar or per-currency tabs.

---

## Phase 17 — Install hook + onboarding DX

### `hooks/install.ts`

```ts
export async function onInstall(_event: any, ctx: PluginContext) {
  // Default settings
  const currentDefault = await ctx.kv.get("settings:defaultCurrency");
  if (!currentDefault) {
    await ctx.kv.set("settings:defaultCurrency", "USD");
    await ctx.kv.set("settings:enabledCurrencies", ["USD"]);
  }
  if ((await ctx.kv.get("settings:taxMode")) === null) {
    await ctx.kv.set("settings:taxMode", "flat");
    await ctx.kv.set("settings:flatTaxRatePercent", 0);
  }
  // Default shipping zone
  const { items } = await ctx.storage.shipping_zones.query({ limit: 1 });
  if (items.length === 0) {
    const zoneId = /* ulid */ "default";
    await ctx.storage.shipping_zones.put(zoneId, {
      id: zoneId, name: "Default zone", locations: [], order: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  // Rotate download signing secret
  if (!(await ctx.kv.get("state:downloadSigningSecret"))) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    await ctx.kv.set("state:downloadSigningSecret", Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""));
  }
  // Schedule crons
  await ctx.cron?.schedule("sweep-stock-locks", { schedule: "*/5 * * * *" });
  await ctx.cron?.schedule("abandoned-cart-scan", { schedule: "0 * * * *" });
  ctx.log.info("DashCommerce installed.");
}
```

### Update README

- 5-step install (bun add, astro.config snippet, seed snippet from `defineProductsCollection`, bun emdash seed, admin Settings → Stripe keys)
- Screenshots placeholder for phase 19

### First-run banner

`SettingsPage` detects missing `stripeSecretKey` and renders a prominent "Connect Stripe" banner with a link to `dashboard.stripe.com/apikeys`.

---

## Phase 19 — Starter example + screenshots + publish

### Files

```
packages/starter/
├── package.json                          # emdash + @dashcommerce/core (workspace: *)
├── astro.config.mjs
├── tsconfig.json
├── seed/seed.json                        # includes defineProductsCollection() output + 6 demo products spanning all types
├── uploads/                              # product images
└── src/
    ├── layouts/Shop.astro                # base layout w/ CurrencySwitcher + cart link
    └── pages/
        ├── index.astro                   # homepage w/ featured products
        ├── shop/
        │   ├── index.astro               # catalog w/ category filter
        │   └── [slug].astro              # product detail
        ├── cart.astro
        ├── checkout.astro
        ├── thank-you/[orderDraftId].astro
        ├── account/
        │   ├── index.astro
        │   ├── orders.astro
        │   ├── subscriptions.astro
        │   └── downloads.astro
        └── vendor/
            ├── apply.astro
            └── dashboard.astro
```

### Demo data

Seed 6 products covering each type:
- Simple: "Enamel Mug" — $15 USD / €14 EUR
- Variable: "T-Shirt" w/ size (S/M/L) × color (black/white)
- Grouped: "Starter Bundle" grouping mug + shirt
- External: "Partner Product" → link to elsewhere
- Subscription: "Monthly Subscription Box" — $29/mo
- Downloadable: "Design Templates" — $9 digital zip

### Screenshots for README

Capture via Puppeteer or manual browser screenshots:
1. Storefront index
2. Product detail with variant selector
3. Cart drawer
4. Checkout page with Stripe Elements
5. Admin Orders page
6. Admin Order Detail with refund panel
7. Admin Settings
8. Admin Reports

### Publish

```sh
cd packages/core
# Update version in package.json to "1.0.0"
npm pack                                  # inspect tarball
cd ../../
# Install the tarball into a throwaway site; verify it works against the tarball, not the workspace link.
cd packages/core
npm publish --access public
cd ../..
git tag v1.0.0
git push --tags
```

Reserve `dashcommerce` on npm (if available) alongside the scoped `@dashcommerce/core` — a thin package that re-exports from `@dashcommerce/core` gives users the shortest `bun add` possible.

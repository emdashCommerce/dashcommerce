# @dashcommerce/starter

**v0.1.0** — a ready-to-run Astro commerce site built on [EmDash CMS](https://github.com/emdash-cms/emdash) and **`@dashcommerce/core@0.1.0`**. Clone, paste your Stripe test keys, run — every feature category the core plugin ships is exercised by a real page.

**Live demo:** [demo.dashcommerce.dev](https://demo.dashcommerce.dev) · **Templates:** [dashcommerce.dev/templates](https://dashcommerce.dev/templates)

## What you get

**Storefront routes**

| Path | Purpose |
|---|---|
| `/` | Homepage with hero, featured products, blog teaser, value props |
| `/shop` | Full catalog grid with currency switcher |
| `/shop/[slug]` | Product detail: variant picker, price map, reviews, add-to-cart |
| `/products/[slug]` | Alias that resolves to `/shop/[slug]` |
| `/category/[slug]` | Products filtered by taxonomy |
| `/tag/[slug]` | Products filtered by tag |
| `/cart` | Full cart page with qty / coupon / shipping controls |
| `/checkout` | Address → Stripe Checkout (hosted) OR inline Payment Element (embedded) |
| `/thank-you/[draftId]` | Post-checkout polling screen — waits for `checkout.session.completed` |
| `/account` | Customer account landing + Stripe customer-portal link (email lookup) |
| `/orders/lookup` | Guest-order lookup by email + order number |
| `/subscriptions/[token]` | Self-service subscription management (pause, resume, cancel) |
| `/blog`, `/blog/[slug]`, `/blog/category/[slug]` | Blog (supports DashCommerce Portable Text blocks inline) |

**Admin**

Mounts alongside at `/_emdash/admin` with the full EmDash surface plus DashCommerce pages: Orders, Customers, Coupons, Shipping, Tax, Subscriptions, Reviews, Vendors, Menus, Reports, Settings — and the five dashboard widgets (Revenue, Low Stock, Recent Orders, Pending Reviews, Failed Renewals).

## Quickstart

```sh
cd packages/starter
bun install
bun run bootstrap   # emdash init + seed (creates DB + 6 demo products)
bun run dev         # Astro at :4321
```

Open `http://localhost:4321/` — you should see the hero with "Enamel Mug" and a product grid.

### Configure Stripe

1. Grab test keys from [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys).
2. Open `http://localhost:4321/_emdash/admin/plugins/dashcommerce/settings`.
3. Paste `stripeSecretKey` (sk_test_…) and `stripePublishableKey` (pk_test_…), click **Save all**.
4. In a second terminal, forward webhook events to your dev server:
   ```sh
   stripe listen --forward-to localhost:4321/_emdash/api/plugins/dashcommerce/checkout/webhook
   ```
   Copy the `whsec_…` the CLI prints → paste into Settings → `stripeWebhookSecret` → save.

### Exercise the checkout

1. Open any product from `/shop`, add to cart.
2. Click the drawer cart → **Checkout**.
3. Fill the contact form → **Continue to payment**.
4. Stripe test card: `4242 4242 4242 4242`, any future expiry, any CVC.
5. Redirect lands on `/thank-you/…`. The page polls `/orders/by-draft?id=…` every 800ms until the webhook fires.
6. Check `/_emdash/admin/plugins/dashcommerce/orders` — your order is listed with a green **Paid** badge.
7. Check your terminal (or an email inbox if SMTP is wired) — the receipt email has fired.

### Exercise the refund path

1. Open the order detail in admin.
2. Click **Refund** → pick full or partial → confirm.
3. The order flips to **Refunded** / **Partially refunded** and a refund email is sent.

### Exercise subscriptions

Add `SUB-001` (Monthly Box) to cart → checkout. Stripe creates a Subscription with a 7-day trial. The `/subscriptions/[token]` page gives the customer self-service controls. `invoice.payment_succeeded` on cycle invoices triggers the renewal email; `invoice.payment_failed` starts the dunning flow.

## Demo seed catalog

Six products spanning every DashCommerce type:

| SKU | Title | Type | Notes |
|---|---|---|---|
| `MUG-001` | Enamel Mug | simple | Physical, priced in USD/EUR/GBP |
| `TEE-001` | Logo Tee | variable | Size + color variants |
| `BUNDLE-001` | Starter Bundle | grouped | Bundles MUG-001 + TEE-001 |
| `EXT-001` | Partner Good | external | Affiliate link, no cart action |
| `SUB-001` | Monthly Box | subscription | $29/mo, 7-day trial |
| `DIG-001` | Design Templates | simple + downloadable | Signed-URL token delivery |

Rebuild the seed from its TypeScript source with:

```sh
bun .emdash/build-seed.ts
```

## Customizing

This is a *starting point*, not a framework. Everything is standard Astro — clone, rewrite.

- **Layout + brand:** `src/layouts/Shop.astro`, `src/components/Header.astro`, `src/styles/global.css`
- **Homepage sections:** all editable in the admin under **Pages → Home** (hero, featured grid, blog teaser, value props)
- **Nav / footer:** admin under **DashCommerce → Menus** (nested up to 4 levels, with mega-menu columns)
- **Product tile + detail:** the starter copies components out of `@dashcommerce/core/astro/components/*`; edit the local copies freely, or drop in your own

The plugin itself lives in `../core` (or `@dashcommerce/core` on npm). Don't fork it — customize at the site level and file an issue if the core needs to change.

## License

MIT, same as DashCommerce.

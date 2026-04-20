# @dashcommerce/starter

**v0.2.0** — a ready-to-run Astro commerce site built on [EmDash CMS](https://github.com/emdash-cms/emdash) 0.5 and **`@dashcommerce/core@0.1.3`**. Every feature category the core plugin ships is exercised by a real page.

**Live demo:** [demo.dashcommerce.dev](https://demo.dashcommerce.dev) · **Templates:** [dashcommerce.dev/templates](https://dashcommerce.dev/templates)

## Quick start

```sh
npm create @dashcommerce@latest
```

Prompts for a project directory + template, downloads the starter, installs, commits. Then:

```sh
cd <your-project>
bun run bootstrap   # emdash init + merge-seed + seed (DB + 6 demo products)
bun run dev         # Astro at :4321
```

Open [http://localhost:4321](http://localhost:4321) — hero with "Enamel Mug" and a product grid. Paste your Stripe test keys at `/_emdash/admin/plugins/dashcommerce/settings` and you're exercising a real checkout in under a minute.

Prefer to clone directly? Works too:

```sh
git clone https://github.com/emdashCommerce/starter
cd starter && bun install && bun run bootstrap && bun run dev
```

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

## Configure Stripe

1. Grab test keys from [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys).
2. Open `http://localhost:4321/_emdash/admin/plugins/dashcommerce/settings`.
3. Paste `stripeSecretKey` (sk_test_…) and `stripePublishableKey` (pk_test_…), click **Save all**.
4. In a second terminal, forward webhook events to your dev server:
   ```sh
   stripe listen --forward-to localhost:4321/_emdash/api/plugins/dashcommerce/checkout/webhook
   ```
   Copy the `whsec_…` the CLI prints → paste into Settings → `stripeWebhookSecret` → save.

### Exercise the checkout

1. Open any product from `/shop`, add to cart → drawer cart → **Checkout**.
2. Fill contact form → **Continue to payment**.
3. Stripe test card: `4242 4242 4242 4242`, any future expiry, any CVC.
4. Redirect lands on `/thank-you/…`. The page polls `/orders/by-draft?id=…` every 800ms until the webhook fires.
5. Check `/_emdash/admin/plugins/dashcommerce/orders` — order is listed with a green **Paid** badge.
6. Receipt email fires (check terminal for the console transport, or an inbox if SMTP is wired).

### Refund path

Open the order in admin → **Refund** → full or partial → confirm. Order flips to **Refunded** / **Partially refunded** and a refund email is sent.

### Subscriptions

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

Rebuild the seed from its TypeScript source with `bun .emdash/build-seed.ts`.

## Deploy

When you're ready to ship, the starter builds for three targets from one codebase. `astro.config.mjs` branches on env vars. Expect to do some post-click configuration on the hosted options — these buttons get you into the provider's dashboard with sensible defaults, not an instant production site.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/emdashCommerce/starter)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/emdashCommerce/starter)
[![Run with Docker](https://img.shields.io/badge/Run%20with-Docker-2496ED?logo=docker&logoColor=white)](#docker)

### Cloudflare Workers (D1 + R2)

Runs on `@astrojs/cloudflare` + `@emdash-cms/cloudflare`. The starter stays multi-tenant — you bring your own D1/KV/R2 ids and pass them in as Worker **environment variables** at deploy time. A build-time patch script wires them into the adapter-generated config right before `wrangler deploy`.

**One-time resource provisioning:**

```sh
wrangler d1 create dashcommerce-demo                 # copy the database_id from output
wrangler r2 bucket create dashcommerce-demo-media
wrangler kv namespace create SESSION                 # copy the namespace id from output
openssl rand -hex 32 | wrangler secret put EMDASH_AUTH_SECRET
openssl rand -hex 32 | wrangler secret put EMDASH_PREVIEW_SECRET
```

**Set these env vars on the Worker project** (Cloudflare dashboard → Settings → Variables):

| Variable | From |
|---|---|
| `CF_D1_DATABASE_ID` | `wrangler d1 create` output |
| `CF_KV_SESSION_ID` | `wrangler kv namespace create` output |
| `CF_R2_BUCKET` | optional — overrides `dashcommerce-demo-media` |
| `CF_R2_PUBLIC_URL` | optional — public bucket URL for media |

**Seed the D1 database** (from your laptop, one time):

```sh
bun run cf:d1:seed       # dumps local SQLite → applies to D1
```

**Deploy** — either click the button or run locally:

```sh
CF_D1_DATABASE_ID=… CF_KV_SESSION_ID=… bun run cf:deploy
```

On CF's hosted build, the dashboard's deploy command should be:

```
npx wrangler deploy --config dist/server/wrangler.json
```

D1 migrations must run via wrangler before deploy (no runtime DDL on Workers).

### Railway (Node + Postgres + S3/R2)

Runs on `@astrojs/node` + any Postgres (Neon free tier works) + S3-compat storage (R2 or AWS). Env vars on the service:

```
DATABASE_URL=postgres://…
SITE_URL=https://your-domain
S3_BUCKET=…  S3_ENDPOINT=…  S3_ACCESS_KEY_ID=…  S3_SECRET_ACCESS_KEY=…
S3_REGION=auto  S3_PUBLIC_URL=https://pub-…
```

One-time seed against the remote DB:

```sh
railway run bun run bootstrap
```

Railway's filesystem is ephemeral — use Postgres, or mount a volume at `/data` and set `SQLITE_URL=file:/data/data.db`.

### Docker

Local run with `docker compose up` from the repo root — storefront at [localhost:4321](http://localhost:4321), SQLite + uploads on named volumes:

```sh
docker compose up
docker compose exec app bun run bootstrap
```

The same image deploys anywhere (Fly, Render, ECS, Kubernetes, bare metal):

```sh
docker build -t ghcr.io/you/dashcommerce .
docker run -p 4321:4321 \
  -e SITE_URL=https://your-domain \
  -e DATABASE_URL=postgres://…   # optional; defaults to SQLite in /data
  -v dashcommerce_data:/data \
  -v dashcommerce_uploads:/app/packages/starter/uploads \
  ghcr.io/you/dashcommerce
```

Swap SQLite for Postgres by uncommenting the `db` service in `docker-compose.yml` and setting `DATABASE_URL`.

## Customizing

This is a *starting point*, not a framework. Everything is standard Astro — edit freely.

- **Layout + brand:** `src/layouts/Shop.astro`, `src/components/Header.astro`, `src/styles/global.css`
- **Homepage sections:** admin under **Pages → Home** (hero, featured grid, blog teaser, value props)
- **Nav / footer:** admin under **DashCommerce → Menus** (nested up to 4 levels, with mega-menu columns)
- **Product tile + detail:** the starter copies components out of `@dashcommerce/core/astro/components/*`; edit the local copies freely, or drop in your own

The plugin itself is `@dashcommerce/core` on npm. Don't fork it — customize at the site level and file an issue if the core needs to change.

## License

MIT, same as DashCommerce.

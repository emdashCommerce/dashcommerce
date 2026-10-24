1. Check the site runs on Cloudflare Workers Paid with a `worker_loaders`
   binding (`"worker_loaders": [{ "binding": "LOADER" }]` in
   `wrangler.jsonc`) and a cron trigger (every minute works well).
2. Set `EMDASH_ENCRYPTION_KEY` on the site so the Stripe keys are stored
   encrypted.
3. Install DashCommerce Lite and approve its access.
4. Open DashCommerce > Settings and add your Stripe secret key. Create a
   Stripe webhook endpoint for the URL and events shown on that page, then
   paste its signing secret into Settings.
5. Add the storefront kit to your theme: copy `storefront/dashcommerce.js`
   and `storefront/dashcommerce.d.ts` to `src/lib/`, and the components in
   `storefront/astro/` to `src/components/`. Use `<AddToCart />` on product
   pages, `<Cart />` on the cart page, `<CartCount />` in the header and
   `<CheckoutSuccess />` on `/checkout/success`.

The kit is in the repository:
https://github.com/emdashCommerce/dashcommerce/tree/main/packages/lite/storefront.
The DashCommerce starter theme has it wired in already.

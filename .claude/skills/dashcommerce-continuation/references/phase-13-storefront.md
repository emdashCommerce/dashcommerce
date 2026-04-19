# Phase 13 — Storefront Astro components + Stripe Elements islands

Everything a store site needs to render product catalog, cart, checkout, and order confirmation. Astro components (server-rendered) wrap React islands (client-hydrated) for interactivity.

## Files

```
packages/core/src/astro/
├── index.ts                         # blockComponents export (PT renderers — phase 14)
├── ProductCard.astro                # product tile for grid
├── ProductGrid.astro                # takes products[] prop or queries via ctx
├── ProductDetails.astro             # full product page w/ variant selector + reviews summary + price in current currency
├── AddToCartButton.astro            # wraps AddToCartIsland
├── CartDrawer.astro                 # wraps CartDrawerIsland
├── CheckoutForm.astro               # wraps CheckoutFormIsland (Stripe Elements)
├── OrderSummary.astro               # post-checkout thank-you page
├── Downloads.astro                  # customer downloads page (phase 8)
├── ReviewsList.astro                # phase 9
├── ReviewForm.astro                 # wraps ReviewFormIsland (phase 9)
├── SubscriptionPortal.astro         # customer self-service (phase 7)
├── CurrencySwitcher.astro           # wraps CurrencySwitcherIsland
└── islands/
    ├── AddToCartIsland.tsx
    ├── CartDrawerIsland.tsx
    ├── CheckoutFormIsland.tsx       # @stripe/react-stripe-js <Elements> + <PaymentElement>
    ├── ReviewFormIsland.tsx
    └── CurrencySwitcherIsland.tsx
```

## Package.json adjustment

These Astro components + React islands need `astro` and `@stripe/react-stripe-js` + `@stripe/stripe-js` as peerDependencies (already in devDeps). Mark them optional peer so headless usage doesn't force install.

## CheckoutFormIsland — the interesting one

```tsx
import { useEffect, useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

interface Props {
  publishableKey: string;
  returnUrl: string; // e.g. window.location.origin + "/thank-you/{orderDraftId}"
}

export default function CheckoutFormIsland({ publishableKey, returnUrl }: Props) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [orderDraftId, setOrderDraftId] = useState<string | null>(null);
  const [stripePromise] = useState(() => loadStripe(publishableKey));

  useEffect(() => {
    fetch("/_emdash/api/plugins/dashcommerce/checkout/create-intent", {
      method: "POST",
      credentials: "include",
    })
      .then((r) => r.json())
      .then((d) => {
        setClientSecret(d.clientSecret);
        setOrderDraftId(d.orderDraftId);
      });
  }, []);

  if (!clientSecret || !orderDraftId) return <div>Loading…</div>;

  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <InnerForm returnUrl={returnUrl.replace("{orderDraftId}", orderDraftId)} />
    </Elements>
  );
}

function InnerForm({ returnUrl }: { returnUrl: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    });
    if (error) setErr(error.message ?? "Payment failed");
    setSubmitting(false);
  }

  return (
    <form onSubmit={onSubmit}>
      <PaymentElement />
      <button type="submit" disabled={!stripe || submitting}>Pay now</button>
      {err && <p role="alert">{err}</p>}
    </form>
  );
}
```

The `return_url` takes the customer to `/thank-you/{orderDraftId}`. The thank-you page polls `/orders/by-draft/:id` until the webhook has written the order (typically <1 s), then shows the order summary.

## AddToCartIsland — thin

```tsx
export default function AddToCartIsland({ productId, variantId }: { productId: string; variantId?: string }) {
  const [adding, setAdding] = useState(false);
  async function add() {
    setAdding(true);
    const res = await fetch("/_emdash/api/plugins/dashcommerce/cart/items", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, variantId, quantity: 1 }),
    });
    if (!res.ok) { alert("Could not add to cart"); setAdding(false); return; }
    // dispatch a custom event CartDrawerIsland listens for
    window.dispatchEvent(new CustomEvent("dashcommerce:cart-updated"));
    setAdding(false);
  }
  return <button disabled={adding} onClick={add}>Add to cart</button>;
}
```

## Astro side

Because Astro components run server-side, and these are delivered by a **native plugin** (host imports `@dashcommerce/core/astro` via `componentsEntry`), they have access to `Astro.locals.emdash` and can query content directly. Use:

```astro
---
// ProductGrid.astro
import ProductCard from "./ProductCard.astro";
const products = Astro.props.products ?? [];
---
<ul class="dc-grid">
  {products.map(p => <li><ProductCard product={p} /></li>)}
</ul>
```

`ProductDetails.astro` owns the variant-selection UX; when the user picks a size/color, it calls `/cart/items` with `variantId`.

## Pitfalls

- **Stripe publishable key is NOT a secret** — safe to embed in page HTML. But read it via settings API on the server, then pass as a prop into the island. Don't inline it in committed code.
- **Client-side `fetch` must use `credentials: "include"`** so the `dashcommerce_sid` cookie round-trips.
- **Thank-you page must poll** (not assume webhook already fired) — Stripe confirm + webhook can race.
- **`@stripe/react-stripe-js`** must be peer-optional; sites that don't use our checkout shouldn't have to install it. Lazy-import inside the island file — the island is only bundled when used.

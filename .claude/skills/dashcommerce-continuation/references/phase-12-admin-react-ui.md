# Phase 12 — Admin React UI

All 12 admin pages + 5 dashboard widgets for the native-format plugin. React components that call `usePluginAPI()` from `@emdash-cms/admin` to hit our own routes under `/_emdash/api/plugins/dashcommerce/admin/*`.

## Files

```
packages/core/src/
├── admin/
│   ├── entry.tsx                          # exports { pages, widgets } — wire every component
│   ├── ui/
│   │   ├── MoneyDisplay.tsx               # renders Money via money.format
│   │   ├── StatusBadge.tsx                # colored chip for OrderStatus etc.
│   │   ├── CurrencyPicker.tsx             # select from enabledCurrencies setting
│   │   ├── DateRangePicker.tsx            # for reports + filters
│   │   └── EmptyState.tsx
│   ├── pages/
│   │   ├── OrdersPage.tsx                 # list w/ filters (status, currency, date range, search by email/number)
│   │   ├── OrderDetailPage.tsx            # detail + line items + tax breakdown + refund panel + customer + shipping
│   │   ├── CustomersPage.tsx              # list w/ search
│   │   ├── CustomerDetailPage.tsx         # profile + addresses + orders + subscriptions
│   │   ├── CouponsPage.tsx                # list + create modal (all 5 discount types)
│   │   ├── ShippingPage.tsx               # zones list → methods → rates editor
│   │   ├── TaxPage.tsx                    # tax mode toggle (flat/table/stripe_tax); rates table for 'table' mode
│   │   ├── SubscriptionsPage.tsx          # list w/ status filter
│   │   ├── ReviewsPage.tsx                # moderation queue; approve/reject/spam
│   │   ├── VendorsPage.tsx                # Connect onboarding links + payouts
│   │   ├── ReportsPage.tsx                # revenue, top products/customers, MRR, vendor payouts
│   │   └── SettingsPage.tsx               # Stripe keys, currencies, store, checkout, inventory, subscriptions, downloads
│   └── widgets/
│       ├── RevenueSnapshot.tsx            # 7/30-day revenue by currency
│       ├── LowStockAlerts.tsx             # products below threshold
│       ├── RecentOrders.tsx               # last 5
│       ├── PendingReviews.tsx             # count in moderation queue
│       └── FailedSubscriptions.tsx        # dunning queue
```

Also: `src/routes/admin-api.ts` with the backend endpoints each page needs.

## Patterns

**Every page component:**
```tsx
import { usePluginAPI } from "@emdash-cms/admin";
import { useEffect, useState } from "react";

export function OrdersPage() {
  const api = usePluginAPI(); // scoped to this plugin's id
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: null, cursor: null });

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await api.get("admin/orders", filters);
      setOrders(res.items);
      setLoading(false);
    })();
  }, [filters]);

  // …
}
```

**API routes** in `routes/admin-api.ts` are declared without `public: true` so the session middleware enforces admin auth. Example:

```ts
"admin/orders": {
  handler: async (routeCtx, ctx) => {
    const url = new URL(routeCtx.request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10), 1), 100);

    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const result = await ctx.storage.orders.query({
      where,
      orderBy: { createdAt: "desc" },
      limit,
      cursor,
    });

    return {
      items: result.items.map(r => ({ id: r.id, ...r.data })),
      cursor: result.cursor,
      hasMore: result.hasMore,
    };
  },
},
```

## Settings page

`SettingsPage` reads settings via `api.get("admin/settings")` and writes via `api.post("admin/settings", newValues)`.

The backend stores each setting as `ctx.kv.set("settings:<key>", value)`. Keep the schema the single source of truth (see `settings.ts` — you'll need to create this file with the settings listed in the original plan's "Settings schema" section).

Secrets (Stripe keys) should be masked in GET response — return `"••••••••" + lastFour` when fetching, accept full value on POST.

## Descriptor update

Register every page + widget in `src/index.ts`:

```ts
adminPages: [
  { path: "/orders", label: "Orders", icon: "shopping-bag" },
  { path: "/orders/:id", label: "Order Detail", icon: "receipt", hiddenInNav: true },
  { path: "/customers", label: "Customers", icon: "users" },
  { path: "/customers/:id", label: "Customer Detail", icon: "user", hiddenInNav: true },
  { path: "/coupons", label: "Coupons", icon: "tag" },
  { path: "/shipping", label: "Shipping", icon: "truck" },
  { path: "/tax", label: "Tax", icon: "percent" },
  { path: "/subscriptions", label: "Subscriptions", icon: "repeat" },
  { path: "/reviews", label: "Reviews", icon: "message-square" },
  { path: "/vendors", label: "Vendors", icon: "store" },
  { path: "/reports", label: "Reports", icon: "bar-chart" },
  { path: "/settings", label: "Settings", icon: "settings" },
],
adminWidgets: [
  { id: "revenue-snapshot", title: "Revenue", size: "half" },
  { id: "low-stock-alerts", title: "Low Stock", size: "half" },
  { id: "recent-orders", title: "Recent Orders", size: "full" },
  { id: "pending-reviews", title: "Pending Reviews", size: "third" },
  { id: "failed-subscriptions", title: "Failed Renewals", size: "third" },
],
```

Check exact field names by reading `PluginAdminPage` in `node_modules/emdash/dist/types-BYWYxLcp.d.mts`.

## Verification

- `bun run typecheck` after each page.
- Browse to `http://localhost:4321/_emdash/admin/plugins/dashcommerce/orders` in the starter — page should render.
- Click-through each page without crashing the router.

## Pitfalls

- **Paths with `:id`** might not be supported by emdash's nav — if so, use query strings (`/orders?id=xxx`) or check how other native plugins handle detail pages.
- **Don't ship a design system** — use `@emdash-cms/admin` primitives (`Card`, `Table`, `Button`, `Input`, `Select`, `Alert`, `Loading`). If you need something custom, one-off style tag inline.
- **Secrets round-trip**: the settings PATCH must accept partial updates. Never wipe existing secrets when the UI sends the masked value.

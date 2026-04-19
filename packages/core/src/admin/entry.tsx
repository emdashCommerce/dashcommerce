/**
 * DashCommerce — React admin entry point.
 *
 * Loaded by emdash's admin shell when the host registers the plugin via
 * `adminEntry: "@dashcommerce/core/admin"`. Exports `pages`, `widgets`,
 * and `fields` maps that emdash mounts at
 * `/_emdash/admin/plugins/dashcommerce/*`.
 *
 * This file runs client-side — it may freely use browser APIs.
 */

import type { ComponentType } from "react";

import { KitPortals } from "./kit";
import { CouponsPage } from "./pages/CouponsPage";
import { CustomersPage } from "./pages/CustomersPage";
import { MenusPage } from "./pages/MenusPage";
import { OrdersPage } from "./pages/OrdersPage";
import { ReportsPage } from "./pages/ReportsPage";
import { ReviewsPage } from "./pages/ReviewsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ShippingPage } from "./pages/ShippingPage";
import { SubscriptionsPage } from "./pages/SubscriptionsPage";
import { TaxPage } from "./pages/TaxPage";
import { VendorsPage } from "./pages/VendorsPage";

import { BgTypeSelect } from "./fields/BgTypeSelect";
import { PriceMapInput } from "./fields/PriceMapInput";
import { VendorSelect } from "./fields/VendorSelect";

import { FailedSubscriptions } from "./widgets/FailedSubscriptions";
import { LowStockAlerts } from "./widgets/LowStockAlerts";
import { PendingReviews } from "./widgets/PendingReviews";
import { RecentOrders } from "./widgets/RecentOrders";
import { RevenueSnapshot } from "./widgets/RevenueSnapshot";

/**
 * Wraps a page so every mount gets the toast + confirm portals without
 * requiring each page to import them explicitly. React dedupes renders via
 * the shared module-level store, so multiple mounts are cheap.
 */
function withPortals<P extends object>(Component: ComponentType<P>): ComponentType<P> {
	function Wrapped(props: P) {
		return (
			<>
				<Component {...props} />
				<KitPortals />
			</>
		);
	}
	Wrapped.displayName = `WithPortals(${Component.displayName ?? Component.name ?? "Page"})`;
	return Wrapped;
}

export const pages: Record<string, ComponentType> = {
	// Emdash's admin shell resolves plugin pages via exact path match, so
	// parametric keys like `/orders/:id` are never mounted. `OrdersPage` and
	// `CustomersPage` render the detail view inline when the hash matches
	// `#/orders/<id>` / `#/customers/<id>` instead.
	"/orders": withPortals(OrdersPage),
	"/customers": withPortals(CustomersPage),
	"/coupons": withPortals(CouponsPage),
	"/shipping": withPortals(ShippingPage),
	"/tax": withPortals(TaxPage),
	"/subscriptions": withPortals(SubscriptionsPage),
	"/reviews": withPortals(ReviewsPage),
	"/vendors": withPortals(VendorsPage),
	"/menus": withPortals(MenusPage),
	"/reports": withPortals(ReportsPage),
	"/settings": withPortals(SettingsPage),
};

export const widgets: Record<string, ComponentType> = {
	"revenue-snapshot": RevenueSnapshot,
	"low-stock-alerts": LowStockAlerts,
	"recent-orders": RecentOrders,
	"pending-reviews": PendingReviews,
	"failed-subscriptions": FailedSubscriptions,
};

/**
 * Content-collection field widgets. Emdash's content editor loads these
 * when a field schema sets `widget: "dashcommerce:<name>"` — see
 * `FieldWidgetConfig` in emdash's plugin types.
 */
export const fields: Record<string, ComponentType<Record<string, unknown>>> = {
	"vendor-select": VendorSelect as ComponentType<Record<string, unknown>>,
	"price-map": PriceMapInput as ComponentType<Record<string, unknown>>,
	"bg-type-select": BgTypeSelect as ComponentType<Record<string, unknown>>,
};

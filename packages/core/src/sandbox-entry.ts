/**
 * DashCommerce — runtime entry point.
 *
 * Loaded by the emdash runtime on the deployed server (or local dev). This
 * module and everything it transitively imports MUST remain sandbox-safe:
 *
 *   - No Node built-ins (`fs`, `path`, `crypto`, `child_process`, …).
 *   - No `require`.
 *   - All HTTP via `ctx.http.fetch` (honors `allowedHosts`).
 *   - All crypto via `crypto.subtle` (Web Crypto).
 *
 * Emdash's astro integration calls `createPlugin(options)` at build time
 * for native-format plugins. `options` comes from the descriptor's
 * `options` field (see src/index.ts). We feed them into
 * `adaptSandboxEntry` to produce a `ResolvedPlugin` — the same shape
 * standard-format plugins get for free.
 */

import { adaptSandboxEntry, definePlugin, type PluginDescriptor } from "emdash";

import { productBeforeSave } from "./hooks/content";
import { cronHandler } from "./hooks/cron";
import { onActivate, onInstall } from "./hooks/install";
import { adminApiRoutes } from "./routes/admin-api";
import { cartRoutes } from "./routes/cart";
import { checkoutRoutes } from "./routes/checkout";
import { configCheckRoutes } from "./routes/config-check";
import { customerPortalRoutes } from "./routes/customer-portal";
import { downloadsRoutes } from "./routes/downloads";
import { ordersPublicRoutes } from "./routes/orders-public";
import { reviewsPublicRoutes } from "./routes/reviews-public";
import { subscriptionsPublicRoutes } from "./routes/subscriptions-public";
import { webhookRoutes } from "./routes/webhook";
import { DASHCOMMERCE_STORAGE } from "./storage-collections";

const DEFAULT_CAPABILITIES = [
	"read:content",
	"write:content",
	"read:media",
	"read:users",
	"network:fetch",
	"email:send",
];
const DEFAULT_ALLOWED_HOSTS = ["api.stripe.com", "files.stripe.com"];

const definition = definePlugin({
	hooks: {
		"content:beforeSave": {
			handler: productBeforeSave,
		},
		cron: {
			handler: cronHandler,
		},
		"plugin:install": {
			handler: onInstall,
		},
		"plugin:activate": {
			handler: onActivate,
		},
	},
	routes: {
		...cartRoutes,
		...checkoutRoutes,
		...configCheckRoutes,
		...customerPortalRoutes,
		...downloadsRoutes,
		...ordersPublicRoutes,
		...reviewsPublicRoutes,
		...subscriptionsPublicRoutes,
		...webhookRoutes,
		...adminApiRoutes,
	},
});

export interface CreatePluginOptions {
	id?: string;
	version?: string;
	capabilities?: string[];
	allowedHosts?: string[];
}

/**
 * Static admin page list — must match src/index.ts adminPages.
 * Defined here so `adaptSandboxEntry` can populate `admin.pages`,
 * which the emdash plugin-manager API reads to set `hasAdminPages`
 * and show the Settings gear link on the Plugins page.
 */
const ADMIN_PAGES: PluginDescriptor["adminPages"] = [
	{ path: "/orders", label: "Orders", icon: "shopping-bag" },
	{ path: "/customers", label: "Customers", icon: "users" },
	{ path: "/coupons", label: "Coupons", icon: "tag" },
	{ path: "/shipping", label: "Shipping", icon: "truck" },
	{ path: "/tax", label: "Tax", icon: "percent" },
	{ path: "/subscriptions", label: "Subscriptions", icon: "repeat" },
	{ path: "/reviews", label: "Reviews", icon: "message-square" },
	{ path: "/vendors", label: "Vendors", icon: "store" },
	{ path: "/menus", label: "Menus", icon: "list" },
	{ path: "/reports", label: "Reports", icon: "bar-chart" },
	{ path: "/settings", label: "Settings", icon: "settings" },
];

const ADMIN_WIDGETS: PluginDescriptor["adminWidgets"] = [
	{ id: "revenue-snapshot", title: "Revenue", size: "half" },
	{ id: "low-stock-alerts", title: "Low Stock", size: "half" },
	{ id: "recent-orders", title: "Recent Orders", size: "full" },
	{ id: "pending-reviews", title: "Pending Reviews", size: "third" },
	{ id: "failed-subscriptions", title: "Failed Renewals", size: "third" },
];

// Custom content-field widgets this plugin provides. The content editor
// resolves `widget: "dashcommerce:<name>"` on a field to the React
// component exported from `admin/entry.tsx` under `fields[name]`.
//
// `adaptSandboxEntry` currently only forwards `adminPages`/`adminWidgets`
// from the descriptor, so we merge these onto `resolved.admin` ourselves
// below. Without that merge the admin manifest wouldn't know the widgets
// exist and the editor would fall back to the default JSON textarea —
// exactly the "prices field is still a text input" symptom.
const FIELD_WIDGETS = [
	{
		name: "vendor-select",
		label: "Vendor picker",
		fieldTypes: ["string"],
	},
	{
		name: "price-map",
		label: "Price map (multi-currency)",
		fieldTypes: ["json"],
	},
];

const PORTABLE_TEXT_BLOCKS = [
	{
		type: "product-embed",
		label: "Embed Product",
		icon: "package",
		description: "Embed a single product card inline.",
	},
	{
		type: "product-grid",
		label: "Product Grid",
		icon: "grid",
		description: "Grid of products from a category.",
	},
	{
		type: "review-quote",
		label: "Review Quote",
		icon: "message-circle",
		description: "Inline quote from an approved review.",
	},
];

/**
 * Native-format entry called by emdash at build time with the options
 * serialized from the descriptor. Returns a ResolvedPlugin ready for the
 * HookPipeline.
 */
export function createPlugin(options: CreatePluginOptions = {}) {
	// adaptSandboxEntry reads id/version/capabilities/allowedHosts/
	// storage/adminPages/adminWidgets from the descriptor to build the
	// ResolvedPlugin. adminPages must be present so the emdash plugin-manager
	// API returns hasAdminPages:true and the Settings link appears.
	const descriptor: PluginDescriptor = {
		id: options.id ?? "dashcommerce",
		version: options.version ?? "0.0.0",
		entrypoint: "@dashcommerce/core/sandbox",
		capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
		allowedHosts: options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
		storage: DASHCOMMERCE_STORAGE,
		adminPages: ADMIN_PAGES,
		adminWidgets: ADMIN_WIDGETS,
	};
	const resolved = adaptSandboxEntry(definition, descriptor);
	// Merge fieldWidgets / portableTextBlocks onto the resolved admin
	// config. adaptSandboxEntry drops these today; without the merge the
	// admin manifest would never learn about `dashcommerce:price-map`
	// and the content editor would render the raw JSON textarea.
	// biome-ignore lint/suspicious/noExplicitAny: widening PluginAdminConfig to attach fields emdash's type doesn't yet declare
	const admin: any = (resolved as unknown as { admin?: unknown }).admin ?? {};
	admin.fieldWidgets = FIELD_WIDGETS;
	admin.portableTextBlocks = PORTABLE_TEXT_BLOCKS;
	(resolved as unknown as { admin: unknown }).admin = admin;
	return resolved;
}

/**
 * Default export kept for direct-import consumers + tests that read the
 * raw { hooks, routes } definition without going through adaptSandboxEntry.
 */
export default definition;

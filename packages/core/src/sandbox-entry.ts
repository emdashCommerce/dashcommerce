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
 * for native-format plugins (`format: "native"` + `entrypoint` in the
 * descriptor — see src/index.ts). `options` comes from the descriptor's
 * `options` field. We build a native `ResolvedPlugin` with `definePlugin`.
 *
 * emdash 0.28 note: route handlers are the NATIVE single-arg shape
 * `(ctx: RouteContext) => Promise<unknown>`, where `RouteContext` extends
 * `PluginContext` — so `ctx` carries both the request (`ctx.request`,
 * `ctx.input`) and the plugin surface (`ctx.storage`, `ctx.kv`, `ctx.http`…).
 * DashCommerce's route handlers are authored two-arg `(routeCtx, ctx)`; we
 * adapt them to the single-arg form below (passing the one context as both).
 * We deliberately do NOT use `adaptSandboxEntry` here: it flattens
 * `routeCtx.request` to `{ url, method, headers }` with no body, which would
 * break the Stripe webhook's raw-body signature verification.
 */

import {
	definePlugin,
	type FieldWidgetConfig,
	type PluginAdminConfig,
	type PluginAdminPage,
	type PluginCapability,
	type PluginContext,
	type PluginDescriptor,
	type PluginRoute,
	type PortableTextBlockConfig,
	type RouteContext,
} from "emdash";

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

const DEFAULT_CAPABILITIES: PluginCapability[] = [
	"content:read",
	"content:write",
	"media:read",
	"users:read",
	"network:request",
	"email:send",
];
const DEFAULT_ALLOWED_HOSTS = ["api.stripe.com", "files.stripe.com"];

/**
 * DashCommerce's route handlers are authored in the two-arg convention
 * `(routeCtx, ctx)` — `routeCtx` for request data (`.request`, `.input`) and
 * `ctx` for the plugin surface. In emdash's native format both are the same
 * `RouteContext` (which extends `PluginContext`), so a single context serves
 * as both. This is the loose entry shape those route maps satisfy.
 */
type CommerceRouteEntry = {
	public?: boolean;
	input?: PluginRoute["input"];
	handler: (routeCtx: RouteContext, ctx: PluginContext) => Promise<unknown>;
};

const HOOKS = {
	"content:beforeSave": { handler: productBeforeSave },
	cron: { handler: cronHandler },
	"plugin:install": { handler: onInstall },
	"plugin:activate": { handler: onActivate },
};

const ROUTES = {
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
} as unknown as Record<string, CommerceRouteEntry>;

/**
 * Adapt the authored two-arg route handlers into emdash's native single-arg
 * `PluginRoute` form. `RouteContext` extends `PluginContext`, so the one
 * `ctx` is passed as both arguments. `public` and `input` pass through.
 */
function toNativeRoutes(
	routes: Record<string, CommerceRouteEntry>,
): Record<string, PluginRoute> {
	const out: Record<string, PluginRoute> = {};
	for (const [name, route] of Object.entries(routes)) {
		out[name] = {
			public: route.public,
			input: route.input,
			handler: (ctx) => route.handler(ctx, ctx),
		};
	}
	return out;
}

/**
 * emdash's `PluginDefinition.storage` requires an `indexes` array on every
 * collection; the descriptor's `storage` declaration leaves it optional.
 * Normalize to the runtime shape.
 */
function toStorageConfig(
	decl: NonNullable<PluginDescriptor["storage"]>,
): Record<string, { indexes: string[]; uniqueIndexes?: string[] }> {
	const out: Record<string, { indexes: string[]; uniqueIndexes?: string[] }> = {};
	for (const [name, cfg] of Object.entries(decl)) {
		out[name] = { indexes: cfg.indexes ?? [], uniqueIndexes: cfg.uniqueIndexes };
	}
	return out;
}

export interface CreatePluginOptions {
	id?: string;
	version?: string;
	capabilities?: PluginCapability[];
	allowedHosts?: string[];
}

/**
 * Static admin page list — must match src/index.ts adminPages. Populates
 * `admin.pages`, which the emdash plugin-manager API reads to set
 * `hasAdminPages` and show the Settings gear link on the Plugins page.
 */
const ADMIN_PAGES: PluginAdminPage[] = [
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

const ADMIN_WIDGETS: NonNullable<PluginAdminConfig["widgets"]> = [
	{ id: "revenue-snapshot", title: "Revenue", size: "half" },
	{ id: "low-stock-alerts", title: "Low Stock", size: "half" },
	{ id: "recent-orders", title: "Recent Orders", size: "full" },
	{ id: "pending-reviews", title: "Pending Reviews", size: "third" },
	{ id: "failed-subscriptions", title: "Failed Renewals", size: "third" },
];

// Custom content-field widgets this plugin provides. The content editor
// resolves `widget: "dashcommerce:<name>"` on a field to the React
// component exported from `admin/entry.tsx` under `fields[name]`.
const FIELD_WIDGETS: FieldWidgetConfig[] = [
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

const PORTABLE_TEXT_BLOCKS: PortableTextBlockConfig[] = [
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
 * Native-format entry called by emdash with the options serialized from the
 * descriptor (see src/index.ts). Returns a `ResolvedPlugin` ready for the
 * HookPipeline.
 */
export function createPlugin(options: CreatePluginOptions = {}) {
	return definePlugin({
		id: options.id ?? "dashcommerce",
		version: options.version ?? "0.0.0",
		capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
		allowedHosts: options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
		storage: toStorageConfig(DASHCOMMERCE_STORAGE),
		hooks: HOOKS,
		routes: toNativeRoutes(ROUTES),
		admin: {
			pages: ADMIN_PAGES,
			widgets: ADMIN_WIDGETS,
			fieldWidgets: FIELD_WIDGETS,
			portableTextBlocks: PORTABLE_TEXT_BLOCKS,
		},
	});
}

/**
 * Default export kept for direct-import consumers + tests that read the raw
 * `{ hooks, routes }` definition without going through `createPlugin`.
 */
export default { hooks: HOOKS, routes: ROUTES };

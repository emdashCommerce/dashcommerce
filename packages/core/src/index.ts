/**
 * DashCommerce — descriptor factory.
 *
 * This file runs in the Vite build context (imported from the host's
 * `astro.config.mjs`). It must be side-effect-free and must not import any
 * runtime code. All hook/route/handler logic lives in `./sandbox-entry.ts`,
 * which is loaded by the emdash runtime via the `entrypoint` field below.
 */

import type { PluginDescriptor } from "emdash";

import pkg from "../package.json" with { type: "json" };
import { DASHCOMMERCE_STORAGE } from "./storage-collections";
import { detectEmDashVersionAtBuildTime, warnIfEmDashPatchMissing } from "./version-check";

export const DASHCOMMERCE_PLUGIN_ID = "dashcommerce";
/** Sourced from package.json so Changesets version bumps cannot drift. */
export const DASHCOMMERCE_VERSION: string = pkg.version;

export interface DashCommerceOptions {
	/**
	 * Override the plugin id. Leave unset for the default ("dashcommerce").
	 * Useful for running multiple independent stores from one host process
	 * (each store gets its own scoped storage + KV namespace).
	 */
	id?: string;

	/**
	 * Extra hosts the plugin may call, for payment providers other than
	 * Stripe, e.g. `["api.paystack.co"]`. They are added to Stripe's hosts,
	 * never instead of them, so Stripe webhooks and refunds keep working
	 * after a merchant switches provider. Exact host names, or `*.domain`
	 * for subdomains.
	 */
	allowedHosts?: string[];

	/**
	 * EmDash version for runtime compatibility check.
	 * Auto-detected at build time if not provided.
	 * @internal - set by the descriptor, not by end users
	 */
	emdashVersion?: string;
}

/**
 * Create the DashCommerce plugin descriptor.
 *
 * Register it in `astro.config.mjs`:
 *
 * ```ts
 * import { dashcommerce } from "@dashcommerce/core";
 *
 * emdash({
 *   plugins: [dashcommerce()],
 * });
 * ```
 */
const STRIPE_HOSTS = ["api.stripe.com", "files.stripe.com"];

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_PATTERN = new RegExp(`^(?:\\*\\.)?${HOST_LABEL}(?:\\.${HOST_LABEL})+$`);

/** Stripe's hosts plus valid extras, lower-cased and de-duplicated. */
function resolveAllowedHosts(extra: string[] | undefined): string[] {
	const hosts = [...STRIPE_HOSTS];
	for (const raw of extra ?? []) {
		const host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
		if (!HOST_PATTERN.test(host)) {
			throw new Error(
				`dashcommerce({ allowedHosts }): "${raw}" is not a host name. Use e.g. "api.paystack.co" or "*.example.com", without a scheme, path or port.`,
			);
		}
		if (!hosts.includes(host)) hosts.push(host);
	}
	return hosts;
}

export function dashcommerce(options: DashCommerceOptions = {}): PluginDescriptor {
	const id = options.id ?? DASHCOMMERCE_PLUGIN_ID;
	const allowedHosts = resolveAllowedHosts(options.allowedHosts);
	const emdashVersion = options.emdashVersion ?? detectEmDashVersionAtBuildTime() ?? undefined;
	warnIfEmDashPatchMissing(emdashVersion);

	return {
		id,
		version: DASHCOMMERCE_VERSION,
		// Native format. Required for adminEntry + componentsEntry —
		// emdash's astro integration throws at config-validation if a
		// standard-format plugin declares either (see
		// node_modules/emdash/dist/astro/index.mjs near line 1305).
		// Our sandbox-entry exports a named `createPlugin(options)` that
		// returns a ResolvedPlugin via adaptSandboxEntry.
		format: "native",
		entrypoint: "@dashcommerce/core/sandbox",
		capabilities: [
			"content:read",
			"content:write",
			"media:read",
			"users:read",
			"network:request",
			"email:send",
		],
		allowedHosts,
		storage: DASHCOMMERCE_STORAGE,
		// Native React admin UI. Pages + widgets populated progressively in Phase 12.
		adminEntry: "@dashcommerce/core/admin",
		// Portable Text block renderers (product-embed, product-grid, review-quote) — Phase 14.
		componentsEntry: "@dashcommerce/core/astro",
		// Only list routes that make sense in the EmDash sidebar. Detail screens
		// (/orders/:id, etc.) stay in admin/entry.tsx for in-app navigation only.
		adminPages: [
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
		],
		adminWidgets: [
			{ id: "revenue-snapshot", title: "Revenue", size: "half" },
			{ id: "low-stock-alerts", title: "Low Stock", size: "half" },
			{ id: "recent-orders", title: "Recent Orders", size: "full" },
			{ id: "pending-reviews", title: "Pending Reviews", size: "third" },
			{ id: "failed-subscriptions", title: "Failed Renewals", size: "third" },
		],
		// Custom content-field widgets. Schemas opt in via
		// `widget: "dashcommerce:<name>"` on any matching field. The React
		// component is resolved at runtime from admin/entry.tsx `fields`.
		fieldWidgets: [
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
		],
		portableTextBlocks: [
			{
				type: "product-embed",
				label: "Embed Product",
				icon: "package",
				description: "Embed a single product card inline.",
				fields: [
					{
						type: "text_input",
						action_id: "product_slug",
						label: "Product slug",
						placeholder: "my-awesome-mug",
					},
				],
			},
			{
				type: "product-grid",
				label: "Product Grid",
				icon: "grid",
				description: "Grid of products from a category.",
				fields: [
					{
						type: "text_input",
						action_id: "category_slug",
						label: "Category slug",
					},
					{
						type: "number_input",
						action_id: "limit",
						label: "Max items",
						initial_value: 6,
						min: 1,
						max: 24,
					},
				],
			},
			{
				type: "review-quote",
				label: "Review Quote",
				icon: "message-circle",
				description: "Inline quote from an approved review.",
				fields: [
					{
						type: "text_input",
						action_id: "review_id",
						label: "Review id",
					},
				],
			},
		],
		// Options are JSON-serialized at build time and passed as the first
		// argument to `createPlugin(options)` at runtime. The sandbox entry
		// reads `id` from here so a custom plugin id flows through (e.g.
		// multi-store setups where each store uses `dashcommerce({ id })`).
		options: {
			id,
			version: DASHCOMMERCE_VERSION,
			capabilities: [
				"content:read",
				"content:write",
				"media:read",
				"users:read",
				"network:request",
				"email:send",
			],
			allowedHosts,
			// Lets createPlugin run the version and shipped-patch check at init.
			...(emdashVersion ? { emdashVersion } : {}),
		},
	} as PluginDescriptor;
}

export { defineProductsCollection, defineProductTaxonomies } from "./seed/products-collection";
export type { DefineProductsCollectionOptions } from "./seed/products-collection";
export { mergeDashCommerceSeed } from "./seed/merge-dashcommerce-seed";
export type { MergeDashCommerceSeedOptions } from "./seed/merge-dashcommerce-seed";
export {
	DEMO_PRODUCTS,
	DEMO_PRODUCT_CATEGORY_TERMS,
	DEMO_PRODUCT_TAG_TERMS,
} from "./seed/demo-catalog";
export type { DemoProductEntry, DemoTaxonomyTerm } from "./seed/demo-catalog";

// Re-export public type surface so consumers can import them from the package root.
export type {
	Address,
	AppliedCoupon,
	BackorderPolicy,
	CartLineItem,
	CartState,
	CountryCode,
	Coupon,
	CouponUsage,
	Customer,
	CustomerAddress,
	CurrencyCode,
	DiscountType,
	DownloadableFile,
	DownloadGrant,
	InventoryLedgerEntry,
	InventoryLedgerReason,
	IsoDateTime,
	Money,
	Order,
	OrderItem,
	OrderStatus,
	PaymentStatus,
	PriceEntry,
	PriceMap,
	ProductFields,
	ProductType,
	ProductVariant,
	RegionCode,
	Refund,
	Review,
	ReviewStatus,
	ReviewSummary,
	ShippingClass,
	ShippingMethod,
	ShippingMethodConfig,
	ShippingMethodType,
	ShippingRateOption,
	ShippingZone,
	StockLock,
	StockLockEntry,
	StockStatus,
	Subscription,
	SubscriptionConfig,
	SubscriptionInvoice,
	SubscriptionStatus,
	TaxLine,
	TaxMode,
	TaxRate,
	Vendor,
	VendorPayout,
	VendorSplit,
} from "./types";

export {
	add,
	compare,
	CurrencyMismatchError,
	format,
	gte,
	isNegative,
	isSameCurrency,
	isZero,
	lte,
	minorUnitsFactor,
	money,
	mul,
	parse,
	percent,
	sub,
	sum,
	THREE_DECIMAL_CURRENCIES,
	ZERO_DECIMAL_CURRENCIES,
	zero,
} from "./money";

export default dashcommerce;

/**
 * DashCommerce — descriptor factory.
 *
 * This file runs in the Vite build context (imported from the host's
 * `astro.config.mjs`). It must be side-effect-free and must not import any
 * runtime code. All hook/route/handler logic lives in `./sandbox-entry.ts`,
 * which is loaded by the emdash runtime via the `entrypoint` field below.
 */

import type { PluginDescriptor } from "emdash";

import { DASHCOMMERCE_STORAGE } from "./storage-collections";

export const DASHCOMMERCE_PLUGIN_ID = "dashcommerce";
export const DASHCOMMERCE_VERSION = "0.1.3";

export interface DashCommerceOptions {
	/**
	 * Override the plugin id. Leave unset for the default ("dashcommerce").
	 * Useful for running multiple independent stores from one host process
	 * (each store gets its own scoped storage + KV namespace).
	 */
	id?: string;
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
export function dashcommerce(options: DashCommerceOptions = {}): PluginDescriptor {
	const id = options.id ?? DASHCOMMERCE_PLUGIN_ID;

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
		allowedHosts: ["api.stripe.com", "files.stripe.com"],
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
			allowedHosts: ["api.stripe.com", "files.stripe.com"],
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

/**
 * `defineProductsCollection` — helper that generates the products content
 * collection schema to paste into the host emdash site's `seed.json`.
 *
 * Plugins cannot declare host content collections themselves, so we provide
 * a function the user can call from anywhere to produce the exact schema
 * dashcommerce expects. If the shape is ever customized upstream, this
 * helper stays the source of truth.
 *
 * Usage (in a one-off script, or logged from the admin Settings page):
 *
 * ```ts
 * import { defineProductsCollection } from "@dashcommerce/core";
 *
 * console.log(JSON.stringify(defineProductsCollection(), null, 2));
 * ```
 *
 * Then paste the result under `collections` in `seed.json` and
 * `bun emdash seed` to apply.
 */

import type { CurrencyCode } from "../money";
import type { ProductType } from "../types";

export interface DefineProductsCollectionOptions {
	/**
	 * Collection slug. Defaults to "products". Override if you need multiple
	 * product catalogs (e.g. `products-retail` + `products-wholesale`).
	 */
	slug?: string;
	/** Singular and plural labels shown in the admin. */
	label?: string;
	labelSingular?: string;
	/**
	 * Public URL structure for individual products on the storefront. Used by
	 * emdash for the "Preview" link in the content editor, menu resolution
	 * and sitemap generation. Must contain `{slug}`.
	 *
	 * Defaults to `/shop/{slug}` to match the route shipped in the
	 * dashcommerce starter (`src/pages/shop/[slug].astro`). Override if your
	 * storefront uses a different path, e.g. `/products/{slug}` or
	 * `/store/{slug}`.
	 */
	urlPattern?: string;
	/**
	 * Currencies to surface as UI hints in the JSON price-map field. Does not
	 * restrict what the plugin will accept at runtime — that's controlled by
	 * the `enabledCurrencies` setting.
	 */
	suggestedCurrencies?: CurrencyCode[];
	/** Include a taxonomy reference to `product_category`. Defaults to true. */
	withCategories?: boolean;
	/** Include a taxonomy reference to `product_tag`. Defaults to true. */
	withTags?: boolean;
}

const ALL_PRODUCT_TYPES: ProductType[] = [
	"simple",
	"variable",
	"grouped",
	"external",
	"subscription",
];

export function defineProductsCollection(
	options: DefineProductsCollectionOptions = {},
): Record<string, unknown> {
	const slug = options.slug ?? "products";
	const label = options.label ?? "Products";
	const labelSingular = options.labelSingular ?? "Product";
	const urlPattern = options.urlPattern ?? "/shop/{slug}";
	// suggestedCurrencies is now vestigial — the price editor widget reads
	// the live `enabledCurrencies` setting at runtime. Kept in the options
	// surface so existing callers don't break.
	void options.suggestedCurrencies;
	const withCategories = options.withCategories ?? true;
	const withTags = options.withTags ?? true;

	const fields: Record<string, unknown>[] = [
		{
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
			searchable: true,
		},
		{
			slug: "featured_image",
			label: "Featured Image",
			type: "image",
			help: "Primary image used on the PDP and in shop listings.",
		},
		// Emdash's repeater field type doesn't allow `image` sub-fields (only
		// primitive scalars are permitted inside a repeater). Rather than ship
		// a custom multi-image widget, we expose four extra optional image
		// slots alongside the featured image. The storefront shows every slot
		// that's set as a gallery thumbnail and falls back gracefully when
		// none are configured.
		{
			slug: "gallery_2",
			label: "Gallery Image 2",
			type: "image",
		},
		{
			slug: "gallery_3",
			label: "Gallery Image 3",
			type: "image",
		},
		{
			slug: "gallery_4",
			label: "Gallery Image 4",
			type: "image",
		},
		{
			slug: "gallery_5",
			label: "Gallery Image 5",
			type: "image",
		},
		{
			slug: "description",
			label: "Description",
			type: "portableText",
			searchable: true,
		},
		{
			slug: "type",
			label: "Product Type",
			type: "select",
			required: true,
			options: ALL_PRODUCT_TYPES.map((t) => ({ value: t, label: t })),
			default: "simple",
		},
		{
			slug: "sku",
			label: "SKU",
			type: "string",
			required: true,
			unique: true,
			help: "Stock-keeping unit. Must be unique across all products.",
		},
		{
			slug: "prices",
			label: "Prices",
			type: "json",
			required: true,
			widget: "dashcommerce:price-map",
			help: "Set a price in each currency your store accepts. Customers whose cart is set to an unpriced currency will not be able to add this product.",
		},
		{
			slug: "manage_stock",
			label: "Track Inventory",
			type: "boolean",
			default: true,
		},
		{
			slug: "stock_quantity",
			label: "Stock Quantity",
			type: "integer",
		},
		{
			slug: "stock_status",
			label: "Stock Status",
			type: "select",
			required: true,
			default: "instock",
			options: [
				{ value: "instock", label: "In stock" },
				{ value: "outofstock", label: "Out of stock" },
				{ value: "onbackorder", label: "On backorder" },
			],
		},
		{
			slug: "backorders",
			label: "Allow Backorders",
			type: "select",
			default: "no",
			options: [
				{ value: "no", label: "Do not allow" },
				{ value: "notify", label: "Allow, but notify customer" },
				{ value: "yes", label: "Allow" },
			],
		},
		{
			slug: "low_stock_threshold",
			label: "Low-stock Threshold",
			type: "integer",
			help: "Triggers the LowStockAlerts widget when stock crosses below this value.",
		},
		{
			slug: "weight_grams",
			label: "Weight (g)",
			type: "integer",
			help: "Used by weight-based shipping calculations.",
		},
		{
			slug: "tax_class",
			label: "Tax Class",
			type: "string",
			default: "standard",
		},
		{
			slug: "shipping_class_slug",
			label: "Shipping Class",
			type: "string",
			help: "Must match a ShippingClass slug configured in DashCommerce → Shipping.",
		},
		{
			slug: "featured",
			label: "Featured",
			type: "boolean",
			default: false,
		},
		{
			slug: "is_downloadable",
			label: "Downloadable",
			type: "boolean",
			default: false,
		},
		{
			slug: "is_virtual",
			label: "Virtual (no shipping)",
			type: "boolean",
			default: false,
		},
		{
			slug: "downloadable_files",
			label: "Downloadable Files",
			type: "json",
			help: 'JSON array. Each entry: { "name": "Manual.pdf", "mediaId": "01K..." } or { "name": "...", "url": "https://..." }. Only used when Downloadable is on.',
		},
		{
			slug: "subscription_config",
			label: "Subscription Config",
			type: "json",
			help: 'Required for subscription products. JSON: { "interval": "month", "intervalCount": 1, "trialDays": 7 }. Interval is one of day | week | month | year.',
		},
		{
			slug: "child_product_ids",
			label: "Child Products (for grouped type)",
			type: "json",
			help: 'JSON array of product ULIDs, e.g. ["01KP...", "01KP..."]. Only used when Product Type = grouped.',
		},
		{
			slug: "product_url",
			label: "Product URL (for external type)",
			type: "string",
			help: "Affiliate / external link. Only used when Product Type = external.",
		},
		{
			slug: "button_text",
			label: "Button Text (for external type)",
			type: "string",
			default: "Buy now",
		},
		{
			slug: "vendor_id",
			label: "Vendor",
			type: "string",
			widget: "dashcommerce:vendor-select",
			help: "Marketplace vendor whose Stripe Connect account receives funds for this product. Only active when multi-vendor is enabled in Settings.",
		},
	];

	return {
		slug,
		label,
		labelSingular,
		urlPattern,
		supports: ["drafts", "revisions", "search", "seo"],
		fields,
		taxonomies: [
			...(withCategories ? ["product_category"] : []),
			...(withTags ? ["product_tag"] : []),
		],
	};
}

/**
 * Convenience taxonomy definitions that pair with the products collection.
 *
 * These are namespaced as `product_category` / `product_tag` (following the
 * WooCommerce convention — `product_cat` / `product_tag`) so they never
 * collide with a generic `category` / `tag` taxonomy the host site might
 * want to use for blog posts, landing pages, or any other content
 * collection. Paste under `taxonomies` in `seed.json`.
 */
export function defineProductTaxonomies(): Record<string, unknown>[] {
	return [
		{
			name: "product_category",
			label: "Product Categories",
			labelSingular: "Product Category",
			hierarchical: true,
			collections: ["products"],
			terms: [],
		},
		{
			name: "product_tag",
			label: "Product Tags",
			labelSingular: "Product Tag",
			hierarchical: false,
			collections: ["products"],
			terms: [],
		},
	];
}

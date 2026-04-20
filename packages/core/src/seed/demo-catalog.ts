/**
 * Demo catalog — six example products spanning every DashCommerce product
 * type, plus curated `product_category` / `product_tag` terms.
 *
 * Shipped as a shared module so both `@dashcommerce/starter` and the
 * `dashcommerce-merge-seed --with-demo-catalog` CLI flag render the same
 * reference data. Good for first-run smoke tests; replace with your own
 * products before going live.
 */

export interface DemoTaxonomyTerm {
	slug: string;
	label: string;
	description?: string;
}

export interface DemoProductEntry {
	id: string;
	slug: string;
	status: "published";
	data: Record<string, unknown>;
	taxonomies?: Record<string, string[]>;
}

export const DEMO_PRODUCT_CATEGORY_TERMS: DemoTaxonomyTerm[] = [
	{
		slug: "physical-goods",
		label: "Physical Goods",
		description:
			"Tangible products that ship — apparel, ceramics, accessories, and everyday objects.",
	},
	{
		slug: "digital-downloads",
		label: "Digital Downloads",
		description:
			"Instantly-delivered files — templates, presets, fonts, e-books, or any downloadable asset.",
	},
	{
		slug: "subscriptions",
		label: "Subscriptions",
		description:
			"Recurring products — monthly boxes, memberships, and any product billed on a schedule.",
	},
	{
		slug: "bundles",
		label: "Bundles & Sets",
		description:
			"Grouped products sold together as a set, typically at a discount.",
	},
];

export const DEMO_PRODUCT_TAG_TERMS: DemoTaxonomyTerm[] = [
	{
		slug: "new-arrival",
		label: "New Arrival",
		description: "Fresh additions to the shop.",
	},
	{
		slug: "bestseller",
		label: "Bestseller",
		description: "Our most-loved products of the season.",
	},
	{
		slug: "sale",
		label: "On Sale",
		description: "Discounted products — while stocks last.",
	},
	{
		slug: "limited-edition",
		label: "Limited Edition",
		description: "Small-run drops. Once they're gone, they're gone.",
	},
	{
		slug: "eco-friendly",
		label: "Eco-Friendly",
		description: "Made from recycled, renewable, or low-impact materials.",
	},
	{
		slug: "gift",
		label: "Great as a Gift",
		description: "Thoughtful picks that make good presents.",
	},
];

export const DEMO_PRODUCTS: DemoProductEntry[] = [
	{
		id: "enamel-mug",
		slug: "enamel-mug",
		status: "published",
		data: {
			title: "Enamel Mug",
			type: "simple",
			sku: "MUG-001",
			prices: { USD: { amount: 1599 } },
			manage_stock: true,
			stock_quantity: 25,
			stock_status: "instock",
			backorders: "no",
			low_stock_threshold: 5,
			weight_grams: 320,
			tax_class: "standard",
			shipping_class_slug: null,
			featured: true,
			is_downloadable: false,
			is_virtual: false,
		},
		taxonomies: {
			product_category: ["physical-goods"],
			product_tag: ["bestseller", "eco-friendly", "gift"],
		},
	},
	{
		id: "graphic-tee",
		slug: "graphic-tee",
		status: "published",
		data: {
			title: "Logo Tee",
			type: "variable",
			sku: "TEE-001",
			prices: { USD: { amount: 2999 } },
			manage_stock: false,
			stock_quantity: null,
			stock_status: "instock",
			backorders: "no",
			low_stock_threshold: null,
			weight_grams: 180,
			tax_class: "standard",
			shipping_class_slug: null,
			featured: false,
			is_downloadable: false,
			is_virtual: false,
		},
		taxonomies: {
			product_category: ["physical-goods"],
			product_tag: ["new-arrival", "gift"],
		},
	},
	{
		id: "starter-bundle",
		slug: "starter-bundle",
		status: "published",
		data: {
			title: "Starter Bundle",
			type: "grouped",
			sku: "BUNDLE-001",
			prices: { USD: { amount: 4499 } },
			manage_stock: false,
			stock_quantity: null,
			stock_status: "instock",
			backorders: "no",
			low_stock_threshold: null,
			weight_grams: null,
			tax_class: "standard",
			shipping_class_slug: null,
			featured: false,
			is_downloadable: false,
			is_virtual: false,
			child_product_ids: ["enamel-mug", "graphic-tee"],
		},
		taxonomies: {
			product_category: ["bundles"],
			product_tag: ["sale", "gift", "bestseller"],
		},
	},
	{
		id: "partner-good",
		slug: "partner-good",
		status: "published",
		data: {
			title: "Partner Good (external)",
			type: "external",
			sku: "EXT-001",
			prices: { USD: { amount: 9900 } },
			manage_stock: false,
			stock_quantity: null,
			stock_status: "instock",
			backorders: "no",
			low_stock_threshold: null,
			weight_grams: null,
			tax_class: "standard",
			shipping_class_slug: null,
			featured: false,
			is_downloadable: false,
			is_virtual: false,
			product_url: "https://example.com/product",
			button_text: "Buy on partner site",
		},
		taxonomies: {
			product_category: ["physical-goods"],
			product_tag: ["limited-edition"],
		},
	},
	{
		id: "monthly-box",
		slug: "monthly-box",
		status: "published",
		data: {
			title: "Monthly Box",
			type: "subscription",
			sku: "SUB-001",
			prices: { USD: { amount: 2900 } },
			manage_stock: false,
			stock_quantity: null,
			stock_status: "instock",
			backorders: "no",
			low_stock_threshold: null,
			weight_grams: 600,
			tax_class: "standard",
			shipping_class_slug: null,
			featured: false,
			is_downloadable: false,
			is_virtual: false,
			subscription_config: { interval: "month", interval_count: 1 },
		},
		taxonomies: {
			product_category: ["subscriptions"],
			product_tag: ["bestseller", "new-arrival", "gift"],
		},
	},
	{
		id: "design-templates",
		slug: "design-templates",
		status: "published",
		data: {
			title: "Design Templates (digital)",
			type: "simple",
			sku: "DIG-001",
			prices: { USD: { amount: 900 } },
			manage_stock: false,
			stock_quantity: null,
			stock_status: "instock",
			backorders: "no",
			low_stock_threshold: null,
			weight_grams: null,
			tax_class: "standard",
			shipping_class_slug: null,
			featured: false,
			is_downloadable: true,
			is_virtual: true,
			downloadable_files: [],
		},
		taxonomies: {
			product_category: ["digital-downloads"],
			product_tag: ["new-arrival", "sale"],
		},
	},
];

/**
 * Normalize an emdash `products` content entry's `data` into our
 * camelCase `ProductFields` shape.
 *
 * emdash returns content fields keyed by the collection's field slugs.
 * `defineProductsCollection()` declares those slugs in snake_case to
 * match conventional DB column naming. Our runtime types
 * (`types.ts → ProductFields`) are camelCase.
 *
 * This function does the one-time bridge from snake_case → camelCase.
 * It is the ONLY place either convention appears; downstream code
 * (`products/pricing`, cart, inventory, orders) reads camelCase and
 * never sees slugs.
 *
 * Callers: every site that fetches a product via `ctx.content.get` or
 * `ctx.content.list`. Storefront components (`ProductCard`,
 * `ProductDetails`) read raw emdash data directly because they never
 * touch `Money` or business rules — they only render display-ready
 * strings.
 */

import type { ProductFields } from "../types";

type RawFields = Record<string, unknown>;

function readBool(v: unknown): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
	return Boolean(v);
}

function readInt(v: unknown): number | null {
	if (v === undefined || v === null) return null;
	const n = typeof v === "string" ? Number.parseInt(v, 10) : (v as number);
	return Number.isFinite(n) ? n : null;
}

function readStr(v: unknown): string | null {
	if (v === undefined || v === null) return null;
	return String(v);
}

/** JSON fields are stored as TEXT in SQLite and may be parsed or raw. */
function readJson<T>(v: unknown): T | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v === "string") {
		try {
			return JSON.parse(v) as T;
		} catch {
			return undefined;
		}
	}
	return v as T;
}

export function normalizeProductFields(raw: RawFields): ProductFields {
	const fields: ProductFields = {
		title: readStr(raw.title) ?? "",
		type: (raw.type as ProductFields["type"]) ?? "simple",
		prices: readJson<ProductFields["prices"]>(raw.prices) ?? {},
		sku: readStr(raw.sku) ?? "",
		manageStock: readBool(raw.manage_stock),
		stockQuantity: readInt(raw.stock_quantity),
		stockStatus:
			(raw.stock_status as ProductFields["stockStatus"]) ?? "instock",
		backorders: (raw.backorders as ProductFields["backorders"]) ?? "no",
		lowStockThreshold: readInt(raw.low_stock_threshold),
		belowThresholdAt: readStr(raw.below_threshold_at),
		weightGrams: readInt(raw.weight_grams),
		taxClass: readStr(raw.tax_class) ?? "standard",
		shippingClassSlug: readStr(raw.shipping_class_slug),
		featured: readBool(raw.featured),
		isDownloadable: readBool(raw.is_downloadable),
		isVirtual: readBool(raw.is_virtual),
	};

	const downloadableFiles = readJson<ProductFields["downloadableFiles"]>(
		raw.downloadable_files,
	);
	if (downloadableFiles) fields.downloadableFiles = downloadableFiles;

	const vendorId = readStr(raw.vendor_id);
	if (vendorId) fields.vendorId = vendorId;

	const subscriptionConfig = readJson<ProductFields["subscriptionConfig"]>(
		raw.subscription_config,
	);
	if (subscriptionConfig) fields.subscriptionConfig = subscriptionConfig;

	const childProductIds = readJson<string[]>(raw.child_product_ids);
	if (childProductIds) fields.childProductIds = childProductIds;

	const productUrl = readStr(raw.product_url);
	if (productUrl) fields.productUrl = productUrl;

	const buttonText = readStr(raw.button_text);
	if (buttonText) fields.buttonText = buttonText;

	return fields;
}

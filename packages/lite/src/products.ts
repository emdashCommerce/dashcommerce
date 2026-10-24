/**
 * Product lookup and pricing.
 *
 * Products live in the site's `products` content collection, the same
 * collection the native plugin seeds, so the editor experience and the
 * storefront templates do not change. Lite reads them with `content:read`
 * and never trusts a price sent by the browser. Stock for products with
 * `manage_stock` comes from the plugin's stock ledger (see stock.ts).
 *
 * Lite sells simple products only. Variable, grouped, external and
 * subscription products need the native plugin for now.
 */

import type { PluginContext } from "emdash/plugin";
import { type Money, normalizeProductFields, type ProductFields, resolvePrice } from "./shared";
import { availableStock, isTracked, type StockRow, stockStore } from "./stock";

export const PRODUCTS_COLLECTION = "products";

export interface PricedProduct {
	id: string;
	title: string;
	unitPrice: Money;
	fields: ProductFields;
	/** Set for products with manage_stock on. */
	stock?: { baseline: number; available: number; backorders: boolean };
}

export type Failure = { ok: false; code: string; message: string };
export type PriceProductResult = { ok: true; product: PricedProduct } | Failure;

export interface LoadedProduct {
	id: string;
	fields: ProductFields;
}

/** Read a published product entry. One content bridge call. */
export async function loadProduct(
	ctx: PluginContext,
	productId: string,
): Promise<LoadedProduct | Failure> {
	if (!ctx.content) {
		return { ok: false, code: "CONTENT_UNAVAILABLE", message: "content:read is not granted" };
	}
	const record = await ctx.content.get(PRODUCTS_COLLECTION, productId);
	if (!record || record.status !== "published") {
		return { ok: false, code: "PRODUCT_NOT_FOUND", message: "Product not found or unavailable" };
	}
	return { id: record.id, fields: normalizeProductFields(record.data) };
}

/** Price and stock check for a loaded product. No I/O. */
export function evaluateProduct(
	product: LoadedProduct,
	currency: string,
	quantity: number,
	row: StockRow | null | undefined,
): PriceProductResult {
	const { fields } = product;
	const available = availableStock(fields, row);
	const check = checkSellable(fields, quantity, available);
	if (check) return check;
	const priced = resolvePrice({ product: fields, currency });
	if (!priced) {
		return {
			ok: false,
			code: "CURRENCY_NOT_PRICED",
			message: `This product has no ${currency} price`,
		};
	}
	return {
		ok: true,
		product: {
			id: product.id,
			title: fields.title,
			unitPrice: priced.unit,
			fields,
			...(available !== null
				? {
						stock: {
							baseline: fields.stockQuantity as number,
							available,
							backorders: fields.backorders !== "no",
						},
					}
				: {}),
		},
	};
}

/** Load, stock-check and price one product. 1 or 2 bridge calls. */
export async function priceProduct(
	ctx: PluginContext,
	productId: string,
	currency: string,
	quantity: number,
): Promise<PriceProductResult> {
	const loaded = await loadProduct(ctx, productId);
	if ("ok" in loaded) return loaded;
	const row = isTracked(loaded.fields) ? await stockStore(ctx).get(loaded.id) : null;
	return evaluateProduct(loaded, currency, quantity, row);
}

/** Returns a failure when Lite cannot sell `quantity` of this product. */
export function checkSellable(
	fields: ProductFields,
	quantity: number,
	available: number | null = fields.manageStock ? fields.stockQuantity : null,
): Failure | null {
	if (fields.type !== "simple") {
		return {
			ok: false,
			code: "PRODUCT_TYPE_UNSUPPORTED",
			message: `${fields.type} products cannot be bought in this store`,
		};
	}
	if (fields.subscriptionConfig) {
		return {
			ok: false,
			code: "PRODUCT_TYPE_UNSUPPORTED",
			message: "Subscriptions cannot be bought in this store",
		};
	}
	if (available === null) {
		if (fields.stockStatus === "outofstock" && fields.backorders !== "yes") {
			return { ok: false, code: "OUT_OF_STOCK", message: "This product is out of stock" };
		}
		return null;
	}
	if (fields.backorders !== "no") return null;
	if (available <= 0) {
		return { ok: false, code: "OUT_OF_STOCK", message: "This product is out of stock" };
	}
	if (quantity > available) {
		return { ok: false, code: "INSUFFICIENT_STOCK", message: `Only ${available} in stock` };
	}
	return null;
}

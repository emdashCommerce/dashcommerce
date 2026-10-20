/**
 * Product lookup and pricing.
 *
 * Products live in the site's `products` content collection, the same
 * collection the native plugin seeds, so the editor experience and the
 * storefront templates do not change. Lite reads them with `content:read`
 * and never trusts a price sent by the browser.
 *
 * Lite sells simple products only. Variable, grouped, external and
 * subscription products need the native plugin for now.
 */

import type { PluginContext } from "emdash/plugin";
import { type Money, normalizeProductFields, type ProductFields, resolvePrice } from "./shared";

export const PRODUCTS_COLLECTION = "products";

export interface PricedProduct {
	id: string;
	title: string;
	unitPrice: Money;
	fields: ProductFields;
}

export type PriceProductResult =
	| { ok: true; product: PricedProduct }
	| { ok: false; code: string; message: string };

export async function priceProduct(
	ctx: PluginContext,
	productId: string,
	currency: string,
	quantity: number,
): Promise<PriceProductResult> {
	if (!ctx.content) {
		return { ok: false, code: "CONTENT_UNAVAILABLE", message: "content:read is not granted" };
	}
	const record = await ctx.content.get(PRODUCTS_COLLECTION, productId);
	if (!record || record.status !== "published") {
		return { ok: false, code: "PRODUCT_NOT_FOUND", message: "Product not found or unavailable" };
	}
	const fields = normalizeProductFields(record.data);
	const check = checkSellable(fields, quantity);
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
		product: { id: record.id, title: fields.title, unitPrice: priced.unit, fields },
	};
}

/** Returns a failure when Lite cannot sell `quantity` of this product. */
export function checkSellable(
	fields: ProductFields,
	quantity: number,
): { ok: false; code: string; message: string } | null {
	if (fields.type !== "simple") {
		return {
			ok: false,
			code: "PRODUCT_TYPE_UNSUPPORTED",
			message: `${fields.type} products are not supported by DashCommerce Lite`,
		};
	}
	if (fields.subscriptionConfig) {
		return {
			ok: false,
			code: "PRODUCT_TYPE_UNSUPPORTED",
			message: "Subscriptions are not supported by DashCommerce Lite",
		};
	}
	if (fields.stockStatus === "outofstock" && fields.backorders !== "yes") {
		return { ok: false, code: "OUT_OF_STOCK", message: "This product is out of stock" };
	}
	if (
		fields.manageStock &&
		fields.stockQuantity !== null &&
		fields.backorders === "no" &&
		quantity > fields.stockQuantity
	) {
		return {
			ok: false,
			code: "INSUFFICIENT_STOCK",
			message: `Only ${Math.max(0, fields.stockQuantity)} in stock`,
		};
	}
	return null;
}

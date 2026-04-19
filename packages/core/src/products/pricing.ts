/**
 * Price resolution.
 *
 * Given `{ productId, variantId?, currency }`, return the `Money` price.
 * Variants override product-level prices when present for the currency;
 * otherwise we fall back to the product's price map.
 *
 * A product/variant is "sellable in currency X" iff `prices[X]` exists.
 * Callers should use `resolvePrice` and handle a `null` return as a
 * hard unavailability (e.g. reject `POST /cart/items`).
 */

import { money, type Money } from "../money";
import type { CurrencyCode, PriceMap, ProductFields, ProductVariant } from "../types";

export interface PriceQuery {
	product: ProductFields;
	variant?: ProductVariant | null;
	currency: CurrencyCode;
}

export interface ResolvedPrice {
	unit: Money;
	compareAt?: Money;
}

export function resolvePrice(query: PriceQuery): ResolvedPrice | null {
	const cc = query.currency.toUpperCase();

	if (query.variant) {
		const entry = query.variant.prices[cc];
		if (entry) {
			return {
				unit: money(cc, entry.amount),
				compareAt:
					entry.compareAtAmount !== undefined
						? money(cc, entry.compareAtAmount)
						: undefined,
			};
		}
		// fall through to product-level pricing
	}

	const entry = query.product.prices[cc];
	if (!entry) return null;
	return {
		unit: money(cc, entry.amount),
		compareAt:
			entry.compareAtAmount !== undefined ? money(cc, entry.compareAtAmount) : undefined,
	};
}

export function supportsCurrency(priceMap: PriceMap, currency: CurrencyCode): boolean {
	return priceMap[currency.toUpperCase()] !== undefined;
}

export function listSupportedCurrencies(priceMap: PriceMap): CurrencyCode[] {
	return Object.keys(priceMap);
}

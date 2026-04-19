/**
 * Coupon validation + discount resolution.
 *
 * A coupon is applicable to a cart iff:
 *   - `status === "active"`
 *   - Within `startsAt`/`endsAt` window (or those fields absent)
 *   - `minAmount` ≤ cart.subtotal ≤ `maxAmount` (currency-matched)
 *   - Currency scope matches (for fixed-amount types)
 *   - At least one cart line matches product/category inclusion filters
 *   - No excluded products/categories are in cart (only a hard block if
 *     `individualUse` applies; otherwise they're skipped during resolve)
 *   - Global `usageLimit` not exceeded
 *   - Per-customer `usageLimitPerCustomer` not exceeded (caller passes count)
 *   - If `individualUse`, cart has no other coupons
 *
 * Discount resolution returns the `Money` value to subtract from cart total.
 */

import { money, percent as pct, type Money, zero, CurrencyMismatchError } from "../money";
import type { AppliedCoupon, CartState, Coupon, DiscountType } from "../types";

export interface CouponValidationContext {
	cart: CartState;
	/**
	 * Slugs of categories attached to each product in cart, keyed by productId.
	 * Plugin's caller is responsible for populating this via `ctx.content`.
	 */
	productCategories?: Record<string, string[]>;
	/** Usage count for this coupon by this customer (0 for guest). */
	usageByCustomer?: number;
}

export type ValidationResult =
	| { ok: true }
	| { ok: false; reason: string };

export function validateCoupon(
	coupon: Coupon,
	ctx: CouponValidationContext,
): ValidationResult {
	const { cart } = ctx;

	if (coupon.status !== "active") return { ok: false, reason: "Coupon inactive." };

	const now = Date.now();
	if (coupon.startsAt && Date.parse(coupon.startsAt) > now) {
		return { ok: false, reason: "Coupon not yet active." };
	}
	if (coupon.endsAt && Date.parse(coupon.endsAt) < now) {
		return { ok: false, reason: "Coupon expired." };
	}

	// Currency scope: fixed_* requires an explicit currency matching the cart
	if (
		(coupon.discountType === "fixed_cart" || coupon.discountType === "fixed_product") &&
		coupon.currency &&
		coupon.currency !== cart.currency
	) {
		return {
			ok: false,
			reason: `Coupon is in ${coupon.currency}; cart is in ${cart.currency}.`,
		};
	}

	if (coupon.minAmount && cart.subtotal.amount < coupon.minAmount.amount) {
		return { ok: false, reason: "Cart subtotal below coupon minimum." };
	}
	if (coupon.maxAmount && cart.subtotal.amount > coupon.maxAmount.amount) {
		return { ok: false, reason: "Cart subtotal above coupon maximum." };
	}

	if (coupon.usageLimit !== undefined && coupon.usageCount >= coupon.usageLimit) {
		return { ok: false, reason: "Coupon usage limit reached." };
	}
	if (
		coupon.usageLimitPerCustomer !== undefined &&
		ctx.usageByCustomer !== undefined &&
		ctx.usageByCustomer >= coupon.usageLimitPerCustomer
	) {
		return { ok: false, reason: "You have already used this coupon." };
	}

	if (coupon.individualUse && cart.coupons.length > 0) {
		return { ok: false, reason: "This coupon cannot be combined with others." };
	}
	if (!coupon.individualUse && cart.coupons.some((c) => c.code === coupon.code)) {
		return { ok: false, reason: "Coupon already applied." };
	}

	const hasProductFilter = Boolean(
		coupon.includedProductIds?.length || coupon.includedCategorySlugs?.length,
	);
	if (hasProductFilter) {
		const anyMatch = cart.items.some((item) => {
			if (coupon.includedProductIds?.includes(item.productId)) return true;
			if (coupon.includedCategorySlugs && ctx.productCategories) {
				const cats = ctx.productCategories[item.productId] ?? [];
				return cats.some((c) => coupon.includedCategorySlugs?.includes(c));
			}
			return false;
		});
		if (!anyMatch) {
			return { ok: false, reason: "Coupon does not apply to any item in cart." };
		}
	}

	return { ok: true };
}

function eligibleItemsSubtotal(
	coupon: Coupon,
	cart: CartState,
	productCategories?: Record<string, string[]>,
): Money {
	const cc = cart.currency;
	let total = 0;
	for (const item of cart.items) {
		if (coupon.excludedProductIds?.includes(item.productId)) continue;
		if (
			coupon.excludedCategorySlugs &&
			productCategories &&
			(productCategories[item.productId] ?? []).some((c) =>
				coupon.excludedCategorySlugs?.includes(c),
			)
		) {
			continue;
		}
		// If inclusion filters exist, limit to matching items only
		if (coupon.includedProductIds?.length || coupon.includedCategorySlugs?.length) {
			const include =
				coupon.includedProductIds?.includes(item.productId) ||
				(coupon.includedCategorySlugs &&
					productCategories &&
					(productCategories[item.productId] ?? []).some((c) =>
						coupon.includedCategorySlugs?.includes(c),
					));
			if (!include) continue;
		}
		total += item.lineSubtotal.amount;
	}
	return money(cc, total);
}

/**
 * Compute the `AppliedCoupon` entry that should be placed on the cart.
 * Throws `CurrencyMismatchError` when the coupon currency does not match.
 */
export function resolveDiscount(
	coupon: Coupon,
	cart: CartState,
	productCategories?: Record<string, string[]>,
): AppliedCoupon {
	const cc = cart.currency;

	// Currency check for fixed-value coupons
	if (
		(coupon.discountType === "fixed_cart" || coupon.discountType === "fixed_product") &&
		coupon.currency &&
		coupon.currency !== cc
	) {
		throw new CurrencyMismatchError(coupon.currency, cc);
	}

	const discountType: DiscountType = coupon.discountType;
	const eligibleSubtotal = eligibleItemsSubtotal(coupon, cart, productCategories);

	let discountAmount: Money;
	let freeShipping = false;

	switch (discountType) {
		case "percent_cart":
			discountAmount = pct(cart.subtotal, coupon.discountValue);
			break;
		case "fixed_cart":
			discountAmount = money(cc, Math.min(coupon.discountValue, cart.subtotal.amount));
			break;
		case "percent_product":
			discountAmount = pct(eligibleSubtotal, coupon.discountValue);
			break;
		case "fixed_product":
			discountAmount = money(
				cc,
				Math.min(coupon.discountValue, eligibleSubtotal.amount),
			);
			break;
		case "free_shipping":
			discountAmount = zero(cc);
			freeShipping = true;
			break;
	}

	return { code: coupon.code, discountAmount, freeShipping };
}

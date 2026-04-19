/**
 * Cart totals pipeline — pure functions, currency-aware.
 *
 *   line subtotals → subtotal
 *   subtotal − (coupon discounts) = taxable amount
 *   shipping from chosen method
 *   tax over (items + optionally shipping)
 *   total = subtotal − discounts + shipping + tax
 *
 * Results are written back onto the returned CartState (immutable — we
 * return a new object). Callers persist via `cart/store.save`.
 */

import { add, money, mul, percent as pct, sub, sum, zero } from "../money";
import type { AppliedCoupon, CartLineItem, CartState, Money, TaxLine } from "../types";

export interface PricingPolicy {
	taxMode: "flat" | "table" | "stripe_tax";
	flatTaxPercent?: number;
	taxAppliesToShipping?: boolean;
	/** Called for "table" mode; returns tax lines given taxable base + context. */
	taxResolver?: (args: {
		base: Money;
		currency: string;
		shippingClassesInCart: string[];
	}) => TaxLine[];
}

export function lineSubtotal(item: CartLineItem): Money {
	return mul(item.unitPrice, item.quantity);
}

export function computeSubtotal(items: CartLineItem[], currency: string): Money {
	if (items.length === 0) return zero(currency);
	return sum(items.map(lineSubtotal), currency);
}

export function computeDiscountTotal(coupons: AppliedCoupon[], currency: string): Money {
	if (coupons.length === 0) return zero(currency);
	return sum(
		coupons.map((c) => c.discountAmount),
		currency,
	);
}

export function computeShippingTotal(cart: Pick<CartState, "shippingMethod" | "currency">): Money {
	return cart.shippingMethod?.amount ?? zero(cart.currency);
}

export function computeTax(
	taxableAmount: Money,
	shipping: Money,
	policy: PricingPolicy,
): { lines: TaxLine[]; total: Money } {
	if (taxableAmount.amount < 0) {
		return { lines: [], total: zero(taxableAmount.currency) };
	}
	const base = policy.taxAppliesToShipping ? add(taxableAmount, shipping) : taxableAmount;
	if (policy.taxMode === "flat") {
		const rate = policy.flatTaxPercent ?? 0;
		if (rate === 0) return { lines: [], total: zero(base.currency) };
		const amount = pct(base, rate);
		const line: TaxLine = { label: "Sales tax", amount, rate };
		return { lines: [line], total: amount };
	}
	if (policy.taxMode === "table" && policy.taxResolver) {
		const lines = policy.taxResolver({
			base,
			currency: base.currency,
			shippingClassesInCart: [],
		});
		const total = lines.length
			? sum(
					lines.map((l) => l.amount),
					base.currency,
				)
			: zero(base.currency);
		return { lines, total };
	}
	// stripe_tax path resolves downstream during checkout, not here.
	return { lines: [], total: zero(base.currency) };
}

/**
 * Recompute totals for a cart. Does NOT re-fetch product prices — the caller
 * has already stamped `unitPrice` and `lineSubtotal` on each item by the
 * time we reach here. This keeps the function pure and fast.
 */
export function recalculate(cart: CartState, policy: PricingPolicy = { taxMode: "flat" }): CartState {
	const cc = cart.currency;
	const subtotal = computeSubtotal(cart.items, cc);
	const discountTotal = computeDiscountTotal(cart.coupons, cc);
	const taxable = sub(subtotal, discountTotal);
	const shippingTotal = computeShippingTotal(cart);
	const { lines, total: taxTotal } = computeTax(taxable, shippingTotal, policy);
	const total = add(add(sub(subtotal, discountTotal), shippingTotal), taxTotal);
	return {
		...cart,
		subtotal,
		discountTotal,
		taxLines: lines,
		taxTotal,
		shippingTotal,
		total: money(cc, Math.max(0, total.amount)),
	};
}

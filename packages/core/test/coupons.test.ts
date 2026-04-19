import { describe, expect, it } from "bun:test";
import { resolveDiscount, validateCoupon } from "../src/coupons/validate";
import { CurrencyMismatchError, money, zero } from "../src/money";
import type { CartLineItem, CartState, Coupon } from "../src/types";

function line(productId: string, qty: number, unit: number): CartLineItem {
	return {
		lineId: `l-${productId}`,
		productId,
		quantity: qty,
		unitPrice: money("USD", unit),
		lineSubtotal: money("USD", unit * qty),
		title: productId,
		isDigital: false,
	};
}

function cartWithItems(items: CartLineItem[]): CartState {
	const subtotalAmount = items.reduce((s, i) => s + i.lineSubtotal.amount, 0);
	return {
		sessionId: "sess",
		currency: "USD",
		items,
		coupons: [],
		taxLines: [],
		subtotal: money("USD", subtotalAmount),
		discountTotal: zero("USD"),
		shippingTotal: zero("USD"),
		taxTotal: zero("USD"),
		total: money("USD", subtotalAmount),
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function baseCoupon(overrides: Partial<Coupon> = {}): Coupon {
	return {
		id: "c1",
		code: "SAVE10",
		discountType: "percent_cart",
		discountValue: 10,
		status: "active",
		excludeSaleItems: false,
		usageCount: 0,
		individualUse: false,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("validateCoupon", () => {
	it("rejects inactive coupons", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		const result = validateCoupon(baseCoupon({ status: "inactive" }), { cart });
		expect(result.ok).toBe(false);
	});

	it("rejects expired coupons", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		const result = validateCoupon(
			baseCoupon({ endsAt: "2000-01-01T00:00:00Z" }),
			{ cart },
		);
		expect(result.ok).toBe(false);
	});

	it("rejects below-minimum subtotal", () => {
		const cart = cartWithItems([line("a", 1, 500)]);
		const result = validateCoupon(
			baseCoupon({ minAmount: money("USD", 1_000) }),
			{ cart },
		);
		expect(result.ok).toBe(false);
	});

	it("rejects usage-limit-reached coupons", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		const result = validateCoupon(
			baseCoupon({ usageLimit: 5, usageCount: 5 }),
			{ cart },
		);
		expect(result.ok).toBe(false);
	});

	it("rejects per-customer usage limit", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		const result = validateCoupon(
			baseCoupon({ usageLimitPerCustomer: 1 }),
			{ cart, usageByCustomer: 1 },
		);
		expect(result.ok).toBe(false);
	});

	it("rejects individual-use coupons when cart already has coupons", () => {
		const cart = {
			...cartWithItems([line("a", 1, 10_000)]),
			coupons: [
				{ code: "OTHER", discountAmount: money("USD", 100), freeShipping: false },
			],
		};
		const result = validateCoupon(baseCoupon({ individualUse: true }), { cart });
		expect(result.ok).toBe(false);
	});

	it("rejects when product filter matches none of the cart lines", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		const result = validateCoupon(
			baseCoupon({ includedProductIds: ["nonexistent"] }),
			{ cart },
		);
		expect(result.ok).toBe(false);
	});

	it("passes for a basic active percent-cart coupon", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		const result = validateCoupon(baseCoupon(), { cart });
		expect(result.ok).toBe(true);
	});
});

describe("resolveDiscount", () => {
	it("percent_cart: applies percent of full subtotal", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		const applied = resolveDiscount(
			baseCoupon({ discountType: "percent_cart", discountValue: 15 }),
			cart,
		);
		expect(applied.discountAmount.amount).toBe(1_500);
		expect(applied.freeShipping).toBe(false);
	});

	it("fixed_cart: caps discount at subtotal", () => {
		const cart = cartWithItems([line("a", 1, 500)]);
		const applied = resolveDiscount(
			baseCoupon({
				discountType: "fixed_cart",
				discountValue: 1_000,
				currency: "USD",
			}),
			cart,
		);
		expect(applied.discountAmount.amount).toBe(500);
	});

	it("fixed_cart: rejects on currency mismatch", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		expect(() =>
			resolveDiscount(
				baseCoupon({
					discountType: "fixed_cart",
					discountValue: 1_000,
					currency: "EUR",
				}),
				cart,
			),
		).toThrow(CurrencyMismatchError);
	});

	it("percent_product: limited to eligible items", () => {
		const cart = cartWithItems([line("a", 1, 10_000), line("b", 1, 5_000)]);
		const applied = resolveDiscount(
			baseCoupon({
				discountType: "percent_product",
				discountValue: 10,
				includedProductIds: ["a"],
			}),
			cart,
		);
		expect(applied.discountAmount.amount).toBe(1_000); // 10% of 10_000, not 15_000
	});

	it("free_shipping: flags shipping bypass, zero discount amount", () => {
		const cart = cartWithItems([line("a", 1, 10_000)]);
		const applied = resolveDiscount(
			baseCoupon({ discountType: "free_shipping", discountValue: 0 }),
			cart,
		);
		expect(applied.discountAmount.amount).toBe(0);
		expect(applied.freeShipping).toBe(true);
	});
});

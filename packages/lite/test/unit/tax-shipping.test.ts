import { describe, expect, test } from "bun:test";
import { CART_HEADER } from "../../src/cart";
import { addItemHandler, getCartHandler } from "../../src/cart-routes";
import { createCheckoutHandler } from "../../src/checkout";
import type { LiteOrder } from "../../src/orders";
import { formatAmount, parseAmount, parsePercent } from "../../src/settings";
import { makeCtx, product } from "../helpers/fake-ctx";
import { addToCart, checkout, okStripe, pay, SK, WH } from "../helpers/flow";

function shop(settings: Record<string, unknown>) {
	return makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH, ...settings },
		products: [
			product("mug"),
			product("ebook", { is_virtual: 1, prices: { USD: { amount: 1000 } } }),
		],
		stripe: okStripe,
	});
}

const form = (t: ReturnType<typeof shop>) => new URLSearchParams(t.httpCalls.at(-1)?.body ?? "");

describe("flat shipping and flat tax", () => {
	test("cart totals include shipping for physical items and tax on the subtotal", async () => {
		const t = shop({ flatShipping: 499, flatTaxPercent: 10 });
		const token = await addToCart(t, [["mug", 2]]);
		const view = (await getCartHandler(t.ctx, { [CART_HEADER]: token })).cart;
		expect(view).toMatchObject({
			subtotal: { amount: 3000 },
			shippingTotal: { amount: 499 },
			taxTotal: { amount: 300 },
			total: { amount: 3799 },
			taxAtCheckout: false,
		});
	});

	test("digital-only carts get no shipping", async () => {
		const t = shop({ flatShipping: 499 });
		const res = (await addItemHandler(t.ctx, {}, { productId: "ebook" })) as {
			cart: { shippingTotal: { amount: number }; total: { amount: number } };
		};
		expect(res.cart.shippingTotal.amount).toBe(0);
		expect(res.cart.total.amount).toBe(1000);
	});

	test("Checkout gets a shipping option and a tax line that add up to the order total", async () => {
		const t = shop({ flatShipping: 499, flatTaxPercent: 8.25 });
		const co = await checkout(t, await addToCart(t, [["mug", 1]]));
		const f = form(t);
		expect(f.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]")).toBe("499");
		expect(f.get("shipping_options[0][shipping_rate_data][display_name]")).toBe("Shipping");
		expect(f.get("line_items[1][price_data][product_data][name]")).toBe("Tax (8.25%)");
		expect(f.get("line_items[1][price_data][unit_amount]")).toBe("124"); // 8.25% of 15.00
		expect(f.get("automatic_tax[enabled]")).toBeNull();
		const order = (await t.orders.get(co.orderId)) as unknown as LiteOrder;
		expect(order).toMatchObject({
			subtotal: { amount: 1500 },
			shippingTotal: { amount: 499 },
			taxTotal: { amount: 124 },
			total: { amount: 2123 },
		});
		expect((await pay(t, co)).body).toMatchObject({ outcome: "paid" });
	});

	test("a settings change after the cart was built returns CART_CHANGED", async () => {
		const t = shop({});
		const token = await addToCart(t, [["mug", 1]]);
		t.settings.set("flatShipping", 500);
		const res = await createCheckoutHandler(t.ctx, { [CART_HEADER]: token }, {});
		expect(res).toMatchObject({
			ok: false,
			error: { code: "CART_CHANGED" },
			cart: { total: { amount: 2000 } },
		});
	});
});

describe("Stripe Tax", () => {
	test("turns on automatic tax and accepts Stripe's tax in the paid amount", async () => {
		const t = shop({ automaticTax: true, flatTaxPercent: 10 });
		const token = await addToCart(t, [["mug", 2]]);
		const view = (await getCartHandler(t.ctx, { [CART_HEADER]: token })).cart;
		expect(view).toMatchObject({
			taxTotal: { amount: 0 },
			total: { amount: 3000 },
			taxAtCheckout: true,
		});

		const co = await checkout(t, token);
		const f = form(t);
		expect(f.get("automatic_tax[enabled]")).toBe("true");
		expect(f.get("line_items[0][price_data][tax_behavior]")).toBe("exclusive");
		expect(f.get("line_items[1][price_data][unit_amount]")).toBeNull();

		const res = await pay(t, co, { amount_total: 3240, total_details: { amount_tax: 240 } });
		expect(res.body).toMatchObject({ outcome: "paid" });
		expect(await t.orders.get(co.orderId)).toMatchObject({
			status: "processing",
			taxTotal: { amount: 240 },
			total: { amount: 3240 },
			amountPaid: 3240,
		});
	});

	test("a charged amount that does not match subtotal plus Stripe tax is held", async () => {
		const t = shop({ automaticTax: true });
		const co = await checkout(t, await addToCart(t, [["mug", 1]]));
		const res = await pay(t, co, { amount_total: 1700, total_details: { amount_tax: 100 } });
		expect(res.body).toMatchObject({ outcome: "paid_amount_mismatch" });
		expect(await t.orders.get(co.orderId)).toMatchObject({ status: "on-hold" });
	});
});

describe("amount and percent parsing", () => {
	test("amounts follow the currency's minor units", () => {
		expect(parseAmount("4.99", "USD")).toBe(499);
		expect(parseAmount("", "USD")).toBe(0);
		expect(parseAmount("5", "JPY")).toBe(5);
		expect(parseAmount("5.5", "JPY")).toBeUndefined();
		expect(parseAmount("4.999", "USD")).toBeUndefined();
		expect(parseAmount("-1", "USD")).toBeUndefined();
		expect(parseAmount("1e3", "USD")).toBeUndefined();
		expect(parseAmount("20000", "USD")).toBeUndefined();
		expect(formatAmount(499, "USD")).toBe("4.99");
		expect(formatAmount(0, "USD")).toBe("");
	});

	test("percent", () => {
		expect(parsePercent("8.25")).toBe(8.25);
		expect(parsePercent("8.25%")).toBe(8.25);
		expect(parsePercent("")).toBe(0);
		expect(parsePercent("51")).toBeUndefined();
		expect(parsePercent("abc")).toBeUndefined();
		expect(parsePercent(7)).toBe(7);
	});
});

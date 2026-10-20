/**
 * Bridge-call budget. On Cloudflare a sandboxed invocation gets 10
 * subrequests; it is not confirmed whether `ctx.*` bridge calls count
 * (see DESIGN.md). These tests pin the current counts so a change that
 * adds calls to the hot paths is noticed.
 */

import { describe, expect, test } from "bun:test";
import { CART_HEADER } from "../../src/cart";
import { addItemHandler, getCartHandler } from "../../src/cart-routes";
import { createCheckoutHandler } from "../../src/checkout";
import { makeCtx, product } from "../helpers/fake-ctx";
import { addToCart, okStripe, SK, WH } from "../helpers/flow";

function shop() {
	return makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH },
		products: [product("a"), product("b"), product("c", { manage_stock: 1, stock_quantity: 5 })],
		stripe: okStripe,
	});
}

describe("bridge calls per request", () => {
	test("cart reads and adds", async () => {
		const t = shop();
		const token = await addToCart(t, [["a", 1]]);
		t.calls.count = 0;
		await getCartHandler(t.ctx, { [CART_HEADER]: token });
		expect(t.calls.count).toBe(2); // settings.list + carts.get
		t.calls.count = 0;
		await addItemHandler(t.ctx, { [CART_HEADER]: token }, { productId: "b" });
		expect(t.calls.count).toBe(4); // settings, cart, content, cart put
		t.calls.count = 0;
		await addItemHandler(t.ctx, { [CART_HEADER]: token }, { productId: "c" });
		expect(t.calls.count).toBe(5); // + stock ledger read for a tracked product
	});

	test("checkout is 6 + lines, including the Stripe request", async () => {
		const t = shop();
		const token = await addToCart(t, [
			["a", 1],
			["b", 1],
			["c", 1],
		]);
		t.calls.count = 0;
		const res = await createCheckoutHandler(t.ctx, { [CART_HEADER]: token }, {});
		expect(res).toMatchObject({ ok: true });
		// settings 1 + cart 1 + content 3 + stock getMany 1 + order put 2 + Stripe 1
		expect(t.calls.count).toBe(9);
	});
});

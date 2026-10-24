/**
 * Checkout double submits (Eng review): the order id and the Stripe
 * idempotency key derive from the cart id and the cart's updatedAt.
 */

import { describe, expect, test } from "bun:test";
import { CART_HEADER } from "../../src/cart";
import { createCheckoutHandler } from "../../src/checkout";
import { type HttpCall, makeCtx, product } from "../helpers/fake-ctx";
import { addToCart, okStripe, SK, WH } from "../helpers/flow";

function shop(stripe = okStripe) {
	return makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH },
		products: [product("p1")],
		stripe,
	});
}

describe("checkout idempotency", () => {
	test("checking out the same cart twice sends the same idempotency key", async () => {
		const t = shop();
		const token = await addToCart(t, [["p1", 1]]);
		const headers = { [CART_HEADER]: token };
		const a = (await createCheckoutHandler(t.ctx, headers, {})) as {
			orderId: string;
			orderKey: string;
		};
		const b = (await createCheckoutHandler(t.ctx, headers, {})) as {
			orderId: string;
			orderKey: string;
		};
		expect(b.orderId).toBe(a.orderId);
		expect(b.orderKey).toBe(a.orderKey);
		const keys = t.httpCalls.map((c: HttpCall) => c.headers["Idempotency-Key"]);
		expect(keys).toHaveLength(2);
		expect(keys[1]).toBe(keys[0]);
		// Same request body too, so Stripe replays instead of rejecting.
		expect(t.httpCalls[1]?.body).toBe(t.httpCalls[0]?.body);
		expect(t.orders.rows.size).toBe(1);

		// Changing the cart starts a new attempt.
		await addToCart(t, [["p1", 1]], token);
		await createCheckoutHandler(t.ctx, headers, {});
		expect(t.httpCalls[2]?.headers["Idempotency-Key"]).not.toBe(keys[0]);
	});

	test("after a Stripe error the next attempt uses a new key", async () => {
		let fail = true;
		const t = shop((call) => {
			if (fail) return { status: 400, body: { error: { message: "bad" } } };
			return okStripe(call);
		});
		const token = await addToCart(t, [["p1", 1]]);
		const headers = { [CART_HEADER]: token };
		expect(await createCheckoutHandler(t.ctx, headers, {})).toMatchObject({ ok: false });
		fail = false;
		expect(await createCheckoutHandler(t.ctx, headers, {})).toMatchObject({ ok: true });
		const [k1, k2] = t.httpCalls.map((c) => c.headers["Idempotency-Key"]);
		expect(k2).not.toBe(k1);
	});
});

import { describe, expect, test } from "bun:test";
import { CART_HEADER, cartIdForToken, cartKey } from "../../src/cart";
import { addItemHandler } from "../../src/cart-routes";
import { createCheckoutHandler } from "../../src/checkout";
import type { LiteOrder } from "../../src/orders";
import { handleStripeWebhook, markPaid } from "../../src/webhook";
import { type HttpCall, makeCtx, product, stripeSignature } from "../helpers/fake-ctx";

const SK = "sk_test_1234567890abcdef";
const WH = "whsec_testsecret123456";

function okStripe(call: HttpCall) {
	if (call.url.endsWith("/checkout/sessions")) {
		return {
			status: 200,
			body: {
				id: "cs_test_1",
				object: "checkout.session",
				url: "https://checkout.stripe.com/c/pay/cs_test_1",
			},
		};
	}
	return { status: 404, body: { error: { message: "not found" } } };
}

async function setup(stripe = okStripe, extraSettings: Record<string, unknown> = {}) {
	const t = makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH, ...extraSettings },
		products: [product("p1"), product("p2", { is_virtual: 1, prices: { USD: { amount: 500 } } })],
		stripe,
	});
	const added = (await addItemHandler(t.ctx, {}, { productId: "p1", quantity: 2 })) as {
		token: string;
	};
	const headers = { [CART_HEADER]: added.token };
	return { ...t, token: added.token, headers };
}

describe("checkout/session", () => {
	test("creates a pending order and a Stripe Checkout Session", async () => {
		const t = await setup(okStripe, { shippingCountries: "US,CA" });
		const res = (await createCheckoutHandler(t.ctx, t.headers, { email: "a@b.co" })) as {
			ok: boolean;
			orderId: string;
			orderKey: string;
			url: string;
		};
		expect(res.ok).toBe(true);
		expect(res.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");

		const order = (await t.orders.get(res.orderId)) as unknown as LiteOrder;
		expect(order.status).toBe("pending");
		expect(order.paymentStatus).toBe("pending");
		expect(order.total).toEqual({ currency: "USD", amount: 3000 });
		expect(order.stripeSessionId).toBe("cs_test_1");
		expect(order.cartId).toBe(await cartIdForToken(t.token));

		expect(t.httpCalls).toHaveLength(1);
		const call = t.httpCalls[0] as HttpCall;
		expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
		expect(call.headers.Authorization).toBe(`Bearer ${SK}`);
		expect(call.headers["Idempotency-Key"]).toBe(`dcl_checkout_${res.orderId}`);
		const form = new URLSearchParams(call.body);
		expect(form.get("mode")).toBe("payment");
		expect(form.get("line_items[0][price_data][unit_amount]")).toBe("1500");
		expect(form.get("line_items[0][quantity]")).toBe("2");
		expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
		expect(form.get("client_reference_id")).toBe(res.orderId);
		expect(form.get("metadata[orderId]")).toBe(res.orderId);
		expect(form.get("payment_intent_data[metadata][orderId]")).toBe(res.orderId);
		expect(form.get("customer_email")).toBe("a@b.co");
		expect(form.get("shipping_address_collection[allowed_countries][1]")).toBe("CA");
		expect(form.get("success_url")).toBe(
			`https://shop.example/checkout/success?order=${res.orderId}&key=${res.orderKey}`,
		);
		expect(form.get("cancel_url")).toBe("https://shop.example/cart");
	});

	test("fails closed without Stripe keys, token or items", async () => {
		const bare = makeCtx();
		expect(await createCheckoutHandler(bare.ctx, {}, {})).toMatchObject({
			error: { code: "STRIPE_NOT_CONFIGURED" },
		});
		const t = await setup();
		expect(await createCheckoutHandler(t.ctx, {}, {})).toMatchObject({
			error: { code: "CART_NOT_FOUND" },
		});
		expect(await createCheckoutHandler(t.ctx, t.headers, { email: "nope" })).toMatchObject({
			error: { code: "INVALID_INPUT" },
		});
		expect(t.httpCalls).toHaveLength(0);
	});

	test("re-prices from the catalogue and refuses a changed total", async () => {
		const t = await setup();
		t.products.set("p1", product("p1", { prices: { USD: { amount: 1700 } } }));
		const res = await createCheckoutHandler(t.ctx, t.headers, {});
		expect(res).toMatchObject({
			ok: false,
			error: { code: "CART_CHANGED" },
			cart: { total: { amount: 3400 } },
		});
		expect(t.httpCalls).toHaveLength(0);
		// Second attempt goes through at the new price.
		const again = await createCheckoutHandler(t.ctx, t.headers, {});
		expect(again).toMatchObject({ ok: true });
	});

	test("rejects carts with items that are no longer sellable", async () => {
		const t = await setup();
		t.products.set("p1", product("p1", { stock_status: "outofstock" }));
		const res = await createCheckoutHandler(t.ctx, t.headers, {});
		expect(res).toMatchObject({ ok: false, error: { code: "CART_INVALID" } });
	});

	test("Stripe errors mark the order failed and do not leak details", async () => {
		const t = await setup(() => ({
			status: 400,
			body: { error: { message: "Invalid API Key provided: sk_test_***" } },
		}));
		const res = await createCheckoutHandler(t.ctx, t.headers, {});
		expect(res).toMatchObject({ ok: false, error: { code: "STRIPE_ERROR" } });
		expect(JSON.stringify(res)).not.toContain("sk_test");
		const [row] = (await t.orders.query()).items;
		expect(row?.data).toMatchObject({ status: "failed", paymentStatus: "failed" });
	});

	test("digital-only carts skip shipping address collection", async () => {
		const t = makeCtx({
			settings: { stripeSecretKey: SK, shippingCountries: "US" },
			products: [product("p2", { is_virtual: 1 })],
			stripe: okStripe,
		});
		const added = (await addItemHandler(t.ctx, {}, { productId: "p2" })) as { token: string };
		await createCheckoutHandler(t.ctx, { [CART_HEADER]: added.token }, {});
		expect(t.httpCalls[0]?.body).not.toContain("shipping_address_collection");
	});
});

describe("stripe/webhook", () => {
	async function checkout() {
		const t = await setup();
		const res = (await createCheckoutHandler(t.ctx, t.headers, {})) as { orderId: string };
		return { ...t, orderId: res.orderId };
	}

	function sessionEvent(
		type: string,
		orderId: string,
		extra: Record<string, unknown> = {},
		id = "evt_1",
	) {
		return JSON.stringify({
			id,
			type,
			data: {
				object: {
					id: "cs_test_1",
					object: "checkout.session",
					client_reference_id: orderId,
					metadata: { orderId },
					payment_status: "paid",
					amount_total: 3000,
					currency: "usd",
					payment_intent: "pi_123",
					customer_details: { email: "buyer@example.com" },
					collected_information: {
						shipping_details: {
							name: "Ada",
							address: { line1: "1 Main St", city: "Town", country: "US", postal_code: "12345" },
						},
					},
					...extra,
				},
			},
		});
	}

	async function deliver(t: Awaited<ReturnType<typeof checkout>>, payload: string, secret = WH) {
		const now = Date.now();
		const sig = await stripeSignature(payload, secret, Math.floor(now / 1000));
		return handleStripeWebhook(t.ctx, payload, { "stripe-signature": sig }, now);
	}

	test("checkout.session.completed marks the order paid and clears the cart", async () => {
		const t = await checkout();
		const res = await deliver(t, sessionEvent("checkout.session.completed", t.orderId));
		expect(res).toEqual({ status: 200, body: { received: true, outcome: "paid" } });
		const order = (await t.orders.get(t.orderId)) as unknown as LiteOrder;
		expect(order).toMatchObject({
			status: "processing",
			paymentStatus: "paid",
			stripePaymentIntentId: "pi_123",
			customerEmail: "buyer@example.com",
			shippingAddress: { name: "Ada", line1: "1 Main St", country: "US", postalCode: "12345" },
		});
		expect(order.paidAt).toBeString();
		expect(t.kv.has(cartKey(order.cartId))).toBe(false);
		expect(await t.stripeEvents.exists("evt_1")).toBe(true);
	});

	test("duplicate deliveries are acknowledged without side effects", async () => {
		const t = await checkout();
		const payload = sessionEvent("checkout.session.completed", t.orderId);
		await deliver(t, payload);
		const before = await t.orders.getVersioned(t.orderId);
		const again = await deliver(t, payload);
		expect(again.body).toMatchObject({ duplicate: true });
		expect(await t.orders.getVersioned(t.orderId)).toEqual(before);
		// A different event id for the same session is idempotent too.
		const third = await deliver(
			t,
			sessionEvent("checkout.session.async_payment_succeeded", t.orderId, {}, "evt_2"),
		);
		expect(third.body).toMatchObject({ outcome: "unchanged" });
	});

	test("bad signatures, stale timestamps and missing secrets are rejected", async () => {
		const t = await checkout();
		const payload = sessionEvent("checkout.session.completed", t.orderId);
		expect((await deliver(t, payload, "whsec_wrongsecret999")).status).toBe(400);
		const old = Math.floor(Date.now() / 1000) - 3600;
		const sig = await stripeSignature(payload, WH, old);
		expect((await handleStripeWebhook(t.ctx, payload, { "stripe-signature": sig })).status).toBe(
			400,
		);
		expect((await handleStripeWebhook(t.ctx, payload, {})).status).toBe(400);
		t.settings.delete("stripeWebhookSecret");
		expect((await deliver(t, payload)).status).toBe(500);
		const order = (await t.orders.get(t.orderId)) as unknown as LiteOrder;
		expect(order.paymentStatus).toBe("pending");
	});

	test("an amount mismatch puts the order on hold", async () => {
		const t = await checkout();
		const res = await deliver(
			t,
			sessionEvent("checkout.session.completed", t.orderId, { amount_total: 100 }),
		);
		expect(res.body).toMatchObject({ outcome: "paid_amount_mismatch" });
		const order = (await t.orders.get(t.orderId)) as unknown as LiteOrder;
		expect(order.status).toBe("on-hold");
		expect(order.amountMismatch?.received).toEqual({ currency: "USD", amount: 100 });
	});

	test("unpaid completion waits; async failure and expiry update the order", async () => {
		const t = await checkout();
		const pending = await deliver(
			t,
			sessionEvent("checkout.session.completed", t.orderId, { payment_status: "unpaid" }),
		);
		expect(pending.body).toMatchObject({ outcome: "awaiting_payment" });
		const failed = await deliver(
			t,
			sessionEvent("checkout.session.async_payment_failed", t.orderId, {}, "evt_f"),
		);
		expect(failed.body).toMatchObject({ outcome: "failed" });
		expect(await t.orders.get(t.orderId)).toMatchObject({
			status: "failed",
			paymentStatus: "failed",
		});

		const t2 = await checkout();
		await deliver(
			t2,
			sessionEvent("checkout.session.expired", t2.orderId, { payment_status: "unpaid" }),
		);
		expect(await t2.orders.get(t2.orderId)).toMatchObject({
			status: "cancelled",
			paymentStatus: "pending",
		});
	});

	test("events for another session or unknown orders do not change orders", async () => {
		const t = await checkout();
		const res = await deliver(
			t,
			sessionEvent("checkout.session.completed", t.orderId, { id: "cs_other" }),
		);
		expect(res.body).toMatchObject({ outcome: "unchanged" });
		const unknown = await deliver(
			t,
			sessionEvent("checkout.session.completed", "nope", {}, "evt_x"),
		);
		expect(unknown.body).toMatchObject({ outcome: "order_not_found" });
		const ignored = await deliver(
			t,
			JSON.stringify({ id: "evt_i", type: "charge.refunded", data: { object: {} } }),
		);
		expect(ignored.body).toMatchObject({ ignored: true });
	});

	test("markPaid is a no-op on an already paid order", () => {
		const order = { paymentStatus: "paid" } as LiteOrder;
		expect(
			markPaid(order, { id: "cs", object: "checkout.session", mode: "payment" }, 0),
		).toBeNull();
	});
});

import { describe, expect, test } from "bun:test";
import { couponFromForm, parseDay, renderCoupons, saveCoupon } from "../../src/admin-coupons";
import { handleAdmin } from "../../src/admin";
import { SUBREQUEST_BUDGET } from "../../src/budget";
import { CART_HEADER, type CartView } from "../../src/cart";
import { applyCouponHandler, removeCouponHandler, updateItemHandler } from "../../src/cart-routes";
import { createCheckoutHandler } from "../../src/checkout";
import { type LiteCoupon, normalizeCode } from "../../src/coupons";
import { ordersCsv } from "../../src/export";
import type { LiteOrder } from "../../src/orders";
import { type HttpCall, makeCtx, product } from "../helpers/fake-ctx";
import { addToCart, countCalls, pay, SK, WH } from "../helpers/flow";

type CartResult = {
	ok: boolean;
	token: string;
	cart: CartView;
	error?: { code: string; message: string };
};
type CheckoutResult = {
	ok: boolean;
	orderId: string;
	orderKey: string;
	url: string;
	error?: { code: string; message: string };
	cart?: CartView;
};

let sessionSeq = 0;
function stripe(call: HttpCall) {
	if (call.url.endsWith("/checkout/sessions")) {
		sessionSeq += 1;
		return {
			status: 200,
			body: {
				id: `cs_c_${sessionSeq}`,
				url: `https://checkout.stripe.com/c/pay/cs_c_${sessionSeq}`,
			},
		};
	}
	if (call.url.endsWith("/coupons")) {
		return {
			status: 200,
			body: { id: `co_${call.headers["Idempotency-Key"] ?? "x"}`, object: "coupon" },
		};
	}
	return { status: 404, body: { error: { message: "not found" } } };
}

function coupon(code: string, rules: Partial<LiteCoupon> = {}): LiteCoupon {
	return {
		code,
		type: "percent",
		value: 10,
		currency: "USD",
		active: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...rules,
	};
}

function setup(settings: Record<string, unknown> = {}, products = [product("p1"), product("p2")]) {
	const t = makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH, ...settings },
		products,
		stripe,
	});
	const coupons = (
		t.ctx.storage as unknown as Record<string, { put(id: string, d: unknown): Promise<void> }>
	).coupons as { put(id: string, d: unknown): Promise<void> };
	return { ...t, addCoupon: (c: LiteCoupon) => coupons.put(c.code, c) };
}

const headers = (token: string) => ({ [CART_HEADER]: token });

async function apply(t: ReturnType<typeof setup>, token: string, code: string) {
	return (await applyCouponHandler(t.ctx, headers(token), { code })) as CartResult;
}

/** Check out the way the storefront kit does: repeat while CHECKOUT_CONTINUE. Returns per-request call counts. */
async function checkoutLoop(t: ReturnType<typeof setup>, token: string, max = 8) {
	const calls: number[] = [];
	for (let i = 0; i < max; i += 1) {
		const { calls: n, result } = await countCalls(t, () =>
			createCheckoutHandler(t.ctx, headers(token), {}),
		);
		calls.push(n);
		const res = result as CheckoutResult;
		if (res.ok || res.error?.code !== "CHECKOUT_CONTINUE") return { res, calls };
	}
	throw new Error("checkout did not finish");
}

describe("coupon codes", () => {
	test("normalizes codes and rejects bad ones", () => {
		expect(normalizeCode(" summer-10 ")).toBe("SUMMER-10");
		expect(normalizeCode("a")).toBeUndefined();
		expect(normalizeCode("no spaces")).toBeUndefined();
		expect(normalizeCode(42)).toBeUndefined();
	});
});

describe("cart/coupon", () => {
	test("a percent coupon comes off the item subtotal, before flat tax", async () => {
		const t = setup({ flatTaxPercent: 10, flatShipping: 500 });
		await t.addCoupon(coupon("SAVE10"));
		const token = await addToCart(t, [["p1", 2]]);
		const res = await apply(t, token, "save10");
		expect(res.ok).toBe(true);
		expect(res.cart.subtotal.amount).toBe(3000);
		expect(res.cart.discountTotal.amount).toBe(300);
		expect(res.cart.taxTotal.amount).toBe(270);
		expect(res.cart.shippingTotal.amount).toBe(500);
		expect(res.cart.total.amount).toBe(3000 - 300 + 270 + 500);
		expect(res.cart.coupon).toMatchObject({ code: "SAVE10", applied: true, freeShipping: false });
	});

	test("a fixed coupon is capped at the item subtotal", async () => {
		const t = setup({ flatShipping: 500 });
		await t.addCoupon(coupon("BIG", { type: "fixed", value: 5000 }));
		const token = await addToCart(t, [["p1", 1]]);
		const res = await apply(t, token, "BIG");
		expect(res.cart.discountTotal.amount).toBe(1500);
		expect(res.cart.total.amount).toBe(500);
	});

	test("a free-shipping coupon removes the flat shipping", async () => {
		const t = setup({ flatShipping: 500 });
		await t.addCoupon(coupon("SHIPFREE", { type: "free_shipping", value: 0 }));
		const token = await addToCart(t, [["p1", 1]]);
		const res = await apply(t, token, "SHIPFREE");
		expect(res.cart.shippingTotal.amount).toBe(0);
		expect(res.cart.discountTotal.amount).toBe(0);
		expect(res.cart.total.amount).toBe(1500);
		expect(res.cart.coupon).toMatchObject({ applied: true, freeShipping: true });
	});

	test("refuses unknown, inactive, expired, future and below-minimum coupons", async () => {
		const t = setup();
		const day = 24 * 60 * 60 * 1000;
		await t.addCoupon(coupon("OFF", { active: false }));
		await t.addCoupon(coupon("OLD", { endsAt: new Date(Date.now() - day).toISOString() }));
		await t.addCoupon(coupon("SOON", { startsAt: new Date(Date.now() + day).toISOString() }));
		await t.addCoupon(coupon("MIN", { minSubtotal: 5000 }));
		const token = await addToCart(t, [["p1", 1]]);
		expect((await apply(t, token, "NOPE")).error?.code).toBe("COUPON_NOT_FOUND");
		expect((await apply(t, token, "OFF")).error?.code).toBe("COUPON_INVALID");
		expect((await apply(t, token, "OLD")).error?.message).toBe("This coupon has expired");
		expect((await apply(t, token, "SOON")).error?.message).toBe("This coupon is not active yet");
		expect((await apply(t, token, "MIN")).error?.message).toBe(
			"Add more to the cart to use this coupon",
		);
		expect((await apply(t, token, "x")).error?.code).toBe("INVALID_INPUT");
	});

	test("needs items in the cart", async () => {
		const t = setup();
		await t.addCoupon(coupon("SAVE10"));
		const res = (await applyCouponHandler(t.ctx, {}, { code: "SAVE10" })) as CartResult;
		expect(res.error?.code).toBe("CART_EMPTY");
	});

	test("stays on the cart but stops applying below its minimum", async () => {
		const t = setup();
		await t.addCoupon(coupon("MIN", { minSubtotal: 2000 }));
		const token = await addToCart(t, [["p1", 2]]);
		const applied = await apply(t, token, "MIN");
		expect(applied.cart.discountTotal.amount).toBe(300);
		const lineId = applied.cart.items[0]?.lineId as string;
		const lower = (await updateItemHandler(t.ctx, headers(token), {
			lineId,
			quantity: 1,
		})) as CartResult;
		expect(lower.cart.discountTotal.amount).toBe(0);
		expect(lower.cart.coupon).toMatchObject({ code: "MIN", applied: false });
		expect(lower.cart.coupon?.minSubtotal).toEqual({ currency: "USD", amount: 2000 });
	});

	test("a new code replaces the old one, and remove takes it off", async () => {
		const t = setup();
		await t.addCoupon(coupon("A10"));
		await t.addCoupon(coupon("B20", { value: 20 }));
		const token = await addToCart(t, [["p1", 2]]);
		await apply(t, token, "A10");
		const b = await apply(t, token, "B20");
		expect(b.cart.coupon?.code).toBe("B20");
		expect(b.cart.discountTotal.amount).toBe(600);
		const removed = (await removeCouponHandler(t.ctx, headers(token))) as CartResult;
		expect(removed.cart.coupon).toBeNull();
		expect(removed.cart.discountTotal.amount).toBe(0);
		expect(removed.cart.total.amount).toBe(3000);
	});

	test("cart routes stay within the bridge-call budget", async () => {
		const t = setup();
		await t.addCoupon(coupon("LIMITED", { usageLimit: 5 }));
		const token = await addToCart(t, [["p1", 1]]);
		const a = await countCalls(t, () => apply(t, token, "LIMITED"));
		expect(a.result.ok).toBe(true);
		expect(a.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
		const r = await countCalls(t, () => removeCouponHandler(t.ctx, headers(token)));
		expect(r.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
	});
});

describe("checkout with a coupon", () => {
	test("re-checks the coupon, then charges the discounted total through a Stripe coupon", async () => {
		const t = setup({ flatTaxPercent: 10, flatShipping: 500 });
		await t.addCoupon(coupon("SAVE10", { usageLimit: 3 }));
		const token = await addToCart(t, [["p1", 2]]);
		await apply(t, token, "SAVE10");

		const { res, calls } = await checkoutLoop(t, token);
		expect(res.ok).toBe(true);
		expect(calls.length).toBe(2);
		for (const n of calls) expect(n).toBeLessThanOrEqual(SUBREQUEST_BUDGET);

		const order = (await t.orders.get(res.orderId)) as unknown as LiteOrder;
		expect(order.couponCode).toBe("SAVE10");
		expect(order.discountTotal).toEqual({ currency: "USD", amount: 300 });
		expect(order.total.amount).toBe(3000 - 300 + 270 + 500);

		const couponCall = t.httpCalls.find((c) => c.url.endsWith("/coupons")) as HttpCall;
		const params = new URLSearchParams(couponCall.body);
		expect(params.get("amount_off")).toBe("300");
		expect(params.get("currency")).toBe("usd");
		expect(params.get("duration")).toBe("once");
		const sessionCall = t.httpCalls.find((c) => c.url.endsWith("/checkout/sessions")) as HttpCall;
		expect(new URLSearchParams(sessionCall.body).get("discounts[0][coupon]")).toMatch(/^co_/);

		// Stripe charges the order total: no mismatch, and the order counts as a use.
		await pay(t, {
			orderId: res.orderId,
			sessionId: order.stripeSessionId as string,
			total: order.total.amount,
		});
		const paid = (await t.orders.get(res.orderId)) as unknown as LiteOrder;
		expect(paid.paymentStatus).toBe("paid");
		expect(paid.amountMismatch).toBeUndefined();
		expect(await t.orders.count({ couponCode: "SAVE10", paymentStatus: { in: ["paid"] } })).toBe(1);
	});

	test("a double submit reuses the same Stripe coupon key", async () => {
		const t = setup();
		await t.addCoupon(coupon("SAVE10"));
		const token = await addToCart(t, [["p1", 1]]);
		await apply(t, token, "SAVE10");
		const first = await checkoutLoop(t, token);
		const again = (await createCheckoutHandler(t.ctx, headers(token), {})) as CheckoutResult;
		expect(again.orderId).toBe(first.res.orderId);
		const keys = t.httpCalls
			.filter((c) => c.url.endsWith("/coupons"))
			.map((c) => c.headers["Idempotency-Key"]);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
	});

	test("a free-shipping coupon needs no Stripe coupon", async () => {
		const t = setup({ flatShipping: 500 });
		await t.addCoupon(coupon("SHIPFREE", { type: "free_shipping", value: 0 }));
		const token = await addToCart(t, [["p1", 1]]);
		await apply(t, token, "SHIPFREE");
		const { res } = await checkoutLoop(t, token);
		expect(res.ok).toBe(true);
		expect(t.httpCalls.some((c) => c.url.endsWith("/coupons"))).toBe(false);
		const session = t.httpCalls.find((c) => c.url.endsWith("/checkout/sessions")) as HttpCall;
		expect(session.body).not.toContain("shipping_options");
		const order = (await t.orders.get(res.orderId)) as unknown as LiteOrder;
		expect(order.couponCode).toBe("SHIPFREE");
		expect(order.total.amount).toBe(1500);
	});

	test("drops a coupon that was used up since it was applied", async () => {
		const t = setup();
		await t.addCoupon(coupon("ONCE", { usageLimit: 1 }));
		const token = await addToCart(t, [["p1", 1]]);
		expect((await apply(t, token, "ONCE")).ok).toBe(true);
		// Someone else's paid order takes the only use.
		await t.orders.put("other", {
			couponCode: "ONCE",
			paymentStatus: "paid",
			status: "processing",
		} as unknown as Record<string, unknown>);
		const { res } = await checkoutLoop(t, token);
		expect(res.ok).toBe(false);
		expect(res.error).toEqual({ code: "COUPON_INVALID", message: "This coupon has been used up" });
		expect(res.cart?.coupon).toBeNull();
		expect(res.cart?.total.amount).toBe(1500);
		// Applying it again is refused too.
		expect((await apply(t, token, "ONCE")).error?.message).toBe("This coupon has been used up");
	});

	test("a fully refunded order gives its use back", async () => {
		const t = setup();
		await t.addCoupon(coupon("ONCE", { usageLimit: 1 }));
		await t.orders.put("refunded", {
			couponCode: "ONCE",
			paymentStatus: "refunded",
			status: "refunded",
		} as unknown as Record<string, unknown>);
		const token = await addToCart(t, [["p1", 1]]);
		expect((await apply(t, token, "ONCE")).ok).toBe(true);
	});

	test("a coupon changed by the merchant sends the cart back for review", async () => {
		const t = setup();
		await t.addCoupon(coupon("SAVE", { value: 10 }));
		const token = await addToCart(t, [["p1", 2]]);
		await apply(t, token, "SAVE");
		await t.addCoupon(coupon("SAVE", { value: 20 }));
		const { res } = await checkoutLoop(t, token);
		expect(res.error?.code).toBe("CART_CHANGED");
		expect(res.cart?.discountTotal.amount).toBe(600);
		const retry = await checkoutLoop(t, token);
		expect(retry.res.ok).toBe(true);
		const order = (await t.orders.get(retry.res.orderId)) as unknown as LiteOrder;
		expect(order.discountTotal?.amount).toBe(600);
	});

	test("a 20-line cart with a coupon finishes within the kit's request cap and the call budget", async () => {
		const products = Array.from({ length: 20 }, (_, i) => product(`p${i}`));
		// More than one list page of other products, so each line is read on its own.
		for (let i = 0; i < 120; i += 1) products.push(product(`filler${i}`));
		const t = setup({}, products);
		await t.addCoupon(coupon("SAVE10", { usageLimit: 10 }));
		const token = await addToCart(
			t,
			products.slice(0, 20).map((p) => [p.id, 1]),
		);
		await apply(t, token, "SAVE10");
		const { res, calls } = await checkoutLoop(t, token);
		expect(res.ok).toBe(true);
		expect(calls.length).toBeLessThanOrEqual(8);
		for (const n of calls) expect(n).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
		const order = (await t.orders.get(res.orderId)) as unknown as LiteOrder;
		expect(order.discountTotal?.amount).toBe(3000);
	});
});

describe("Coupons admin page", () => {
	test("parses the form", () => {
		const now = Date.parse("2026-11-19T12:00:00Z");
		const made = couponFromForm(
			{
				code: "summer",
				type: "fixed",
				value: "5.00",
				minSubtotal: "20",
				usageLimit: 3,
				startsAt: "2026-12-01",
				endsAt: "2026-12-31",
				active: true,
			},
			"USD",
			null,
			now,
		);
		expect(made).toMatchObject({
			code: "SUMMER",
			type: "fixed",
			value: 500,
			minSubtotal: 2000,
			usageLimit: 3,
			startsAt: "2026-12-01T00:00:00.000Z",
			endsAt: "2026-12-31T23:59:59.999Z",
			active: true,
		});
		expect(couponFromForm({ code: "X1", type: "percent", value: "150" }, "USD", null)).toBe(
			"Enter a whole percent from 1 to 100",
		);
		expect(couponFromForm({ code: "X1", type: "fixed", value: "" }, "USD", null)).toMatch(/amount/);
		expect(
			couponFromForm(
				{ code: "X1", type: "free_shipping", startsAt: "2026-12-31", endsAt: "2026-12-01" },
				"USD",
				null,
			),
		).toBe("The end date is before the start date");
		expect(parseDay("31/12/2026", false)).toBeNull();
		expect(parseDay("", true)).toBeUndefined();
	});

	test("creates, refuses a duplicate code, edits and deletes", async () => {
		const t = setup();
		const created = await saveCoupon(t.ctx, "coupon:new", {
			code: "save5",
			type: "percent",
			value: "5",
		});
		expect(created.toast).toEqual({ message: "Coupon SAVE5 saved", type: "success" });
		const dup = await saveCoupon(t.ctx, "coupon:new", {
			code: "SAVE5",
			type: "percent",
			value: "7",
		});
		expect(dup.toast?.type).toBe("error");

		const edited = await saveCoupon(t.ctx, "coupon:SAVE5", {
			type: "percent",
			value: "8",
			active: false,
		});
		expect(edited.toast?.type).toBe("success");
		const stored = (await (
			t.ctx.storage as unknown as { coupons: { get(id: string): Promise<LiteCoupon> } }
		).coupons.get("SAVE5")) as LiteCoupon;
		expect(stored).toMatchObject({ value: 8, active: false });

		const deleted = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "coupon_delete",
			value: "SAVE5",
		});
		expect(deleted.toast).toEqual({ message: "Coupon SAVE5 deleted", type: "success" });
	});

	test("every Coupons interaction stays within the call budget", async () => {
		const t = setup();
		await t.addCoupon(coupon("LIMITED", { usageLimit: 5 }));
		const interactions = [
			{ type: "page_load", page: "/coupons" },
			{ type: "block_action", action_id: "coupon_new" },
			{ type: "block_action", action_id: "coupon_edit", value: "LIMITED" },
			{ type: "block_action", action_id: "coupons_page" },
			{
				type: "form_submit",
				action_id: "save_coupon",
				block_id: "coupon:LIMITED",
				values: { type: "percent", value: "15", usageLimit: 5, active: true },
			},
			{
				type: "form_submit",
				action_id: "save_coupon",
				block_id: "coupon:new",
				values: { code: "NEW1", type: "free_shipping" },
			},
			{ type: "block_action", action_id: "coupon_delete", value: "NEW1" },
		];
		for (const interaction of interactions) {
			const { calls } = await countCalls(t, () => handleAdmin(t.ctx, interaction));
			expect(calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
		}
		const page = await renderCoupons(t.ctx, undefined, { edit: "LIMITED" });
		expect(JSON.stringify(page.blocks)).toContain("0 of 5");
	});
});

describe("orders CSV", () => {
	test("has discount and coupon columns", () => {
		const csv = ordersCsv([
			{
				id: "o1",
				data: {
					orderNumber: "DCL-1",
					orderKey: "k",
					cartId: "c",
					status: "processing",
					paymentStatus: "paid",
					currency: "USD",
					items: [],
					subtotal: { currency: "USD", amount: 3000 },
					couponCode: "SAVE10",
					discountTotal: { currency: "USD", amount: 300 },
					total: { currency: "USD", amount: 2700 },
					createdAt: "2026-11-19T00:00:00.000Z",
					updatedAt: "2026-11-19T00:00:00.000Z",
				},
			},
		]);
		const [header, row] = csv.trim().split("\n");
		const cols = (header as string).split(",");
		const cells = (row as string).split(",");
		expect(cells[cols.indexOf("discount")]).toBe("3.00");
		expect(cells[cols.indexOf("coupon")]).toBe("SAVE10");
	});
});

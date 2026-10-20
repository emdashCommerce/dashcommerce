import { describe, expect, test } from "bun:test";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { handleAdmin } from "../../src/admin";
import { CART_TTL_MS } from "../../src/cart";
import {
	CLEANUP_SCHEDULE,
	CLEANUP_TASK,
	handleCron,
	runCleanup,
	scheduleCleanup,
	STALE_ORDER_MS,
} from "../../src/cron";
import type { LiteOrder } from "../../src/orders";
import plugin from "../../src/plugin";
import { applyRefund } from "../../src/webhook";
import { makeCtx, product } from "../helpers/fake-ctx";
import { addToCart, checkout, okStripe, pay, refund, SK, WH } from "../helpers/flow";

const policy = { pluginPagePaths: ["/orders", "/stock", "/settings"] };

function shop() {
	return makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH },
		products: [product("p1")],
		stripe: okStripe,
	});
}
const get = async (t: ReturnType<typeof shop>, id: string) =>
	(await t.orders.get(id)) as unknown as LiteOrder;

describe("charge.refunded", () => {
	test("partial then full refund update payment and order status", async () => {
		const t = shop();
		const co = await checkout(t, await addToCart(t, [["p1", 2]]));
		await pay(t, co);
		expect((await refund(t, co.orderId, 3000, 1000)).body).toMatchObject({
			outcome: "partially_refunded",
		});
		expect(await get(t, co.orderId)).toMatchObject({
			status: "partially-refunded",
			paymentStatus: "partially-refunded",
			refundedAmount: 1000,
		});
		const detail = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "view_order",
			value: co.orderId,
		});
		const v = validateBlockResponse(detail, policy);
		expect(v.valid).toBe(true);
		const json = JSON.stringify(detail);
		expect(json).toContain("Partly refunded");
		expect(json).toContain("$10.00");
		expect(json).toContain("https://dashboard.stripe.com/test/payments/pi_");

		expect((await refund(t, co.orderId, 3000, 3000)).body).toMatchObject({ outcome: "refunded" });
		expect(await get(t, co.orderId)).toMatchObject({
			status: "refunded",
			paymentStatus: "refunded",
			refundedAmount: 3000,
		});
	});

	test("a late, smaller refund event is ignored; lookup works by PaymentIntent", async () => {
		const t = shop();
		const co = await checkout(t, await addToCart(t, [["p1", 2]]));
		await pay(t, co);
		await refund(t, co.orderId, 3000, 3000, { metadata: false });
		expect((await get(t, co.orderId)).paymentStatus).toBe("refunded");
		expect((await refund(t, co.orderId, 3000, 1000, { metadata: false })).body).toMatchObject({
			outcome: "unchanged",
		});
		expect((await get(t, co.orderId)).refundedAmount).toBe(3000);
	});

	test("refunds for unpaid or unknown orders change nothing", async () => {
		const t = shop();
		const co = await checkout(t, await addToCart(t, [["p1", 1]]));
		expect((await refund(t, co.orderId, 1500, 1500)).body).toMatchObject({ outcome: "unchanged" });
		expect((await refund(t, "nope", 1500, 1500, { metadata: false })).body).toMatchObject({
			outcome: "order_not_found",
		});
	});

	test("applyRefund ignores a charge for another PaymentIntent", () => {
		const o = {
			paymentStatus: "paid",
			status: "processing",
			stripePaymentIntentId: "pi_a",
			total: { currency: "USD", amount: 100 },
		} as LiteOrder;
		expect(applyRefund(o, 100, { payment_intent: "pi_b", amount: 100 }, 0)).toBeNull();
		expect(applyRefund(o, 100, { payment_intent: "pi_a", amount: 100 }, 0)).toMatchObject({
			paymentStatus: "refunded",
		});
	});
});

describe("cleanup cron", () => {
	test("install and activate schedule the hourly task", async () => {
		const t = shop();
		await scheduleCleanup(t.ctx);
		expect(t.cronTasks.get(CLEANUP_TASK)).toEqual({ schedule: CLEANUP_SCHEDULE });
		const hooks = plugin.hooks as Record<string, unknown>;
		expect(Object.keys(hooks).sort()).toEqual(["cron", "plugin:activate", "plugin:install"]);
	});

	test("deletes expired carts, cancels stale pending orders, prunes old events", async () => {
		const t = shop();
		const now = Date.now();
		await addToCart(t, [["p1", 1]]); // fresh cart
		const stale = await checkout(t, await addToCart(t, [["p1", 1]]));
		const paid = await checkout(t, await addToCart(t, [["p1", 1]]));
		await pay(t, paid);
		const recent = await checkout(t, await addToCart(t, [["p1", 1]]));
		// Age the stale and paid orders past 25 hours.
		for (const id of [stale.orderId, paid.orderId]) {
			const o = await get(t, id);
			await t.orders.put(id, {
				...o,
				createdAt: new Date(now - STALE_ORDER_MS - 60_000).toISOString(),
			} as never);
		}
		await t.stripeEvents.put("evt_old", {
			type: "x",
			createdAt: new Date(now - 31 * 86_400_000).toISOString(),
		});
		// The paid cart was already deleted by the webhook; three remain.
		expect(t.carts.rows.size).toBe(3);

		const later = now + CART_TTL_MS + 1000;
		const res = await runCleanup(t.ctx, later);
		expect(res.carts).toBe(3);
		expect(t.carts.rows.size).toBe(0);
		expect(res.orders).toBe(2); // stale + recent are both > 25h old at `later`
		expect(await get(t, stale.orderId)).toMatchObject({
			status: "cancelled",
			cancelReason: "stale",
		});
		expect(await get(t, recent.orderId)).toMatchObject({ status: "cancelled" });
		expect(await get(t, paid.orderId)).toMatchObject({ status: "processing" });
		expect(res.events).toBeGreaterThanOrEqual(1);
		expect(await t.stripeEvents.exists("evt_old")).toBe(false);
	});

	test("leaves recent orders and live carts alone", async () => {
		const t = shop();
		await checkout(t, await addToCart(t, [["p1", 1]]));
		const res = await runCleanup(t.ctx);
		expect(res).toEqual({ carts: 0, orders: 0, events: 0 });
		await handleCron({ name: "other", scheduledAt: new Date().toISOString() }, t.ctx);
	});
});

/**
 * Retry safety (Eng review must-fixes):
 *   - a webhook that throws part-way is retried by Stripe and completes the
 *     stock change exactly once (sale, refund restore, admin cancel),
 *   - a replayed payment event never moves a refunded order back to paid,
 *   - a refund that arrives before the payment answers 500 and is not
 *     recorded, so Stripe delivers it again,
 *   - delayed payment methods wait on hold and the cleanup cron leaves them.
 */

import { describe, expect, test } from "bun:test";
import { handleAdmin } from "../../src/admin";
import { runCleanup } from "../../src/cron";
import type { LiteOrder } from "../../src/orders";
import { markPaid } from "../../src/webhook";
import { type MemoryCollection, makeCtx, product } from "../helpers/fake-ctx";
import { addToCart, checkout, deliver, okStripe, pay, refund, SK, WH } from "../helpers/flow";

function shop(stripe = okStripe) {
	return makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH },
		products: [
			product("s1", { manage_stock: 1, stock_quantity: 10 }),
			product("s2", { manage_stock: 1, stock_quantity: 4 }),
			product("p1"),
		],
		stripe,
	});
}
type Shop = ReturnType<typeof shop>;

/** Make `method` on a storage collection throw on its next `times` calls. */
function failNext(col: MemoryCollection, method: string, times = 1, skip = 0) {
	const target = col as unknown as Record<string, (...a: unknown[]) => unknown>;
	const original = target[method] as (...a: unknown[]) => unknown;
	let seen = 0;
	target[method] = (...args: unknown[]) => {
		seen += 1;
		if (seen > skip && seen <= skip + times) return Promise.reject(new Error(`boom: ${method}`));
		return original.apply(col, args);
	};
}

const onHand = (t: Shop, id: string) =>
	(t.stock.rows.get(id)?.data as { onHand: number } | undefined)?.onHand;
const order = async (t: Shop, id: string) => (await t.orders.get(id)) as unknown as LiteOrder;
const moveState = (t: Shop, orderId: string, productId: string) =>
	(t.stockMoves.rows.get(`${orderId}:${productId}`)?.data as { state: string } | undefined)?.state;

async function checkedOut(t: Shop, lines: Array<[string, number]> = [["s1", 3]]) {
	const co = await checkout(t, await addToCart(t, lines));
	return co;
}

describe("webhook retries take stock exactly once", () => {
	test("a throw after the order is marked paid: the retry finishes the sale", async () => {
		const t = shop();
		const co = await checkedOut(t);
		failNext(t.carts, "delete");
		const first = await pay(t, co, {});
		expect(first.status).toBe(500);
		expect(t.stripeEvents.rows.size).toBe(0); // not recorded as done
		expect(await order(t, co.orderId)).toMatchObject({ paymentStatus: "paid" });
		expect((await order(t, co.orderId)).paidEffectsAt).toBeUndefined();
		expect(onHand(t, "s1")).toBe(7);

		// The order already reads paid, but the retry still finishes the job.
		const retry = await pay(t, co, {});
		expect(retry.body).toMatchObject({ outcome: "paid" });
		expect(onHand(t, "s1")).toBe(7);
		const o = await order(t, co.orderId);
		expect(o.paidEffectsAt).toBeString();
		expect(t.carts.rows.has(o.cartId)).toBe(false);
	});

	test("redelivering the same event after a mid-webhook throw completes once", async () => {
		const t = shop();
		const co = await checkedOut(t, [
			["s1", 3],
			["s2", 1],
		]);
		const session = {
			id: co.sessionId,
			object: "checkout.session",
			client_reference_id: co.orderId,
			metadata: { orderId: co.orderId },
			payment_status: "paid",
			amount_total: co.total,
			currency: "usd",
			payment_intent: `pi_${co.orderId}`,
		};
		// Crash between the second line's stock row write and its move record.
		failNext(t.stockMoves, "compareAndSet", 1, 1);
		const first = await deliver(t, "checkout.session.completed", session, "evt_pay");
		expect(first.status).toBe(500);
		expect(await t.stripeEvents.exists("evt_pay")).toBe(false);
		expect(onHand(t, "s1")).toBe(7);
		expect(onHand(t, "s2")).toBe(3); // row written, move not recorded
		expect(moveState(t, co.orderId, "s2")).toBeUndefined();

		const retry = await deliver(t, "checkout.session.completed", session, "evt_pay");
		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({ outcome: "paid" });
		expect(onHand(t, "s1")).toBe(7);
		expect(onHand(t, "s2")).toBe(3);
		expect(moveState(t, co.orderId, "s1")).toBe("deducted");
		expect(moveState(t, co.orderId, "s2")).toBe("deducted");
		expect(await t.stripeEvents.exists("evt_pay")).toBe(true);
		const o = await order(t, co.orderId);
		expect(o.paidEffectsAt).toBeString();
		expect(t.carts.rows.has(o.cartId)).toBe(false);

		// Later deliveries are duplicates; a fresh event id is a no-op too.
		expect((await deliver(t, "checkout.session.completed", session, "evt_pay")).body).toMatchObject(
			{ duplicate: true },
		);
		expect(
			(await deliver(t, "checkout.session.completed", session, "evt_pay2")).body,
		).toMatchObject({ outcome: "unchanged" });
		expect(onHand(t, "s1")).toBe(7);
		expect(onHand(t, "s2")).toBe(3);
	});

	test("a throw before any stock was taken: the retry takes it", async () => {
		const t = shop();
		const co = await checkedOut(t);
		failNext(t.stock, "getVersioned");
		expect((await pay(t, co, {})).status).toBe(500);
		expect(onHand(t, "s1")).toBeUndefined();
		const retry = await pay(t, co, {});
		expect(retry.body).toMatchObject({ outcome: "paid" });
		expect(onHand(t, "s1")).toBe(7);
	});

	test("a stock shortfall found on the retry is still reported", async () => {
		const t = shop();
		const co = await checkedOut(t, [["s2", 4]]);
		// Someone else bought 2 meanwhile: 4 - 2 - 4 = -2.
		await t.stock.put("s2", { productId: "s2", title: "x", onHand: 2, baseline: 4, updatedAt: "" });
		failNext(t.carts, "delete");
		expect((await pay(t, co, {})).status).toBe(500);
		const retry = await pay(t, co, {});
		expect(retry.body).toMatchObject({ outcome: "paid_stock_shortfall" });
		expect(onHand(t, "s2")).toBe(-2);
		expect(await order(t, co.orderId)).toMatchObject({
			status: "on-hold",
			stockShortfall: [{ productId: "s2", short: 2 }],
		});
	});

	test("refund restore that throws part-way is completed once on retry", async () => {
		const t = shop();
		const co = await checkedOut(t);
		await pay(t, co);
		expect(onHand(t, "s1")).toBe(7);
		failNext(t.stockMoves, "updateIf"); // after the row was restored
		const first = await refund(t, co.orderId, co.total, co.total, { id: "evt_ref" });
		expect(first.status).toBe(500);
		expect(await t.stripeEvents.exists("evt_ref")).toBe(false);
		expect(onHand(t, "s1")).toBe(10);
		expect(await order(t, co.orderId)).toMatchObject({
			paymentStatus: "refunded",
			stock: "restored",
		});

		const retry = await refund(t, co.orderId, co.total, co.total, { id: "evt_ref" });
		expect(retry.status).toBe(200);
		expect(onHand(t, "s1")).toBe(10);
		expect(moveState(t, co.orderId, "s1")).toBe("restored");
		// Another refund event for the same charge changes nothing.
		await refund(t, co.orderId, co.total, co.total, { id: "evt_ref2" });
		expect(onHand(t, "s1")).toBe(10);
	});

	test("refund restore that throws before the row write is completed on retry", async () => {
		const t = shop();
		const co = await checkedOut(t);
		await pay(t, co);
		failNext(t.stock, "getVersioned");
		expect((await refund(t, co.orderId, co.total, co.total, { id: "evt_r" })).status).toBe(500);
		expect(onHand(t, "s1")).toBe(7);
		expect((await refund(t, co.orderId, co.total, co.total, { id: "evt_r" })).status).toBe(200);
		expect(onHand(t, "s1")).toBe(10);
	});

	test("admin cancel that throws part-way restores once when clicked again", async () => {
		const t = shop();
		const co = await checkedOut(t);
		await pay(t, co);
		const cancel = () =>
			handleAdmin(t.ctx, {
				type: "block_action",
				action_id: "set_status",
				value: `${co.orderId}:cancelled`,
			});
		failNext(t.stock, "compareAndSet");
		await expect(cancel()).rejects.toThrow("boom");
		expect(await order(t, co.orderId)).toMatchObject({ status: "cancelled", stock: "restored" });
		expect(onHand(t, "s1")).toBe(7);
		await cancel();
		expect(onHand(t, "s1")).toBe(10);
		await cancel();
		expect(onHand(t, "s1")).toBe(10);
		expect(moveState(t, co.orderId, "s1")).toBe("restored");
	});
});

describe("paid transitions", () => {
	test("a replayed completed event on a refunded order is a no-op", async () => {
		const t = shop();
		const token = await addToCart(t, [["s1", 3]]);
		const co = await checkout(t, token);
		await pay(t, co);
		await refund(t, co.orderId, co.total, co.total);
		expect(onHand(t, "s1")).toBe(10);
		// The shopper starts a new cart with the same token.
		await addToCart(t, [["p1", 1]], token);
		const before = await order(t, co.orderId);
		const carts = t.carts.rows.size;

		const replay = await pay(t, co);
		expect(replay.status).toBe(200);
		expect(replay.body).toMatchObject({ outcome: "unchanged" });
		expect(await order(t, co.orderId)).toEqual(before);
		expect(before).toMatchObject({ status: "refunded", paymentStatus: "refunded" });
		expect(onHand(t, "s1")).toBe(10);
		expect(t.carts.rows.size).toBe(carts);
	});

	test("markPaid only moves pending or failed orders", () => {
		const session = {
			id: "cs",
			object: "checkout.session" as const,
			mode: "payment" as const,
			amount_total: 100,
			currency: "usd",
		};
		const base = {
			total: { currency: "USD", amount: 100 },
			currency: "USD",
			items: [],
		} as unknown as LiteOrder;
		const at = (status: string, paymentStatus: string, extra = {}) =>
			markPaid({ ...base, status, paymentStatus, ...extra } as LiteOrder, session, 0);
		expect(at("pending", "pending")).toMatchObject({ paymentStatus: "paid", status: "processing" });
		expect(at("failed", "failed")).toMatchObject({ paymentStatus: "paid" });
		expect(at("on-hold", "pending", { awaitingAsyncPayment: true })).toMatchObject({
			paymentStatus: "paid",
			status: "processing",
		});
		expect(at("refunded", "refunded")).toBeNull();
		expect(at("partially-refunded", "partially-refunded")).toBeNull();
		expect(at("cancelled", "pending")).toBeNull();
		expect(at("on-hold", "paid")).toBeNull();
		expect(at("on-hold", "pending")).toBeNull();
		expect(at("processing", "paid")).toBeNull();
		expect(at("completed", "paid")).toBeNull();
	});

	test("payment for a cancelled order does not reopen it", async () => {
		const t = shop();
		const co = await checkedOut(t);
		await deliver(t, "checkout.session.expired", {
			id: co.sessionId,
			metadata: { orderId: co.orderId },
		});
		const res = await pay(t, co);
		expect(res.body).toMatchObject({ outcome: "not_payable" });
		expect(await order(t, co.orderId)).toMatchObject({
			status: "cancelled",
			paymentStatus: "pending",
		});
		expect(onHand(t, "s1")).toBeUndefined();
	});
});

describe("refund before payment", () => {
	test("answers 500, is not recorded, and applies once the order is paid", async () => {
		const t = shop();
		const co = await checkedOut(t);
		const early = await refund(t, co.orderId, co.total, co.total, { id: "evt_early" });
		expect(early.status).toBeGreaterThanOrEqual(500);
		expect(await t.stripeEvents.exists("evt_early")).toBe(false);
		expect(await order(t, co.orderId)).toMatchObject({ paymentStatus: "pending" });

		await pay(t, co);
		const later = await refund(t, co.orderId, co.total, co.total, { id: "evt_early" });
		expect(later.status).toBe(200);
		expect(later.body).toMatchObject({ outcome: "refunded" });
		expect(await t.stripeEvents.exists("evt_early")).toBe(true);
		expect(onHand(t, "s1")).toBe(10);
	});
});

describe("delayed payment methods", () => {
	const session = (co: { orderId: string; sessionId: string; total: number }, status: string) => ({
		id: co.sessionId,
		object: "checkout.session",
		client_reference_id: co.orderId,
		metadata: { orderId: co.orderId },
		payment_status: status,
		amount_total: co.total,
		currency: "usd",
		payment_intent: `pi_${co.orderId}`,
	});

	test("waits on hold, survives cleanup, then succeeds and takes stock once", async () => {
		const t = shop();
		const co = await checkedOut(t);
		const done = await deliver(t, "checkout.session.completed", session(co, "unpaid"));
		expect(done.body).toMatchObject({ outcome: "awaiting_async_payment" });
		expect(await order(t, co.orderId)).toMatchObject({
			status: "on-hold",
			paymentStatus: "pending",
			awaitingAsyncPayment: true,
		});
		expect(onHand(t, "s1")).toBeUndefined();

		// Bank debits can take days. The cleanup cron must not cancel it,
		// and a late expiry event must not either.
		const res = await runCleanup(t.ctx, Date.now() + 4 * 86_400_000);
		expect(res.orders).toBe(0);
		await deliver(t, "checkout.session.expired", session(co, "unpaid"));
		expect(await order(t, co.orderId)).toMatchObject({ status: "on-hold" });

		// A refund can't apply yet either.
		expect((await refund(t, co.orderId, co.total, co.total)).status).toBe(500);

		const ok = await deliver(t, "checkout.session.async_payment_succeeded", session(co, "paid"));
		expect(ok.body).toMatchObject({ outcome: "paid" });
		const o = await order(t, co.orderId);
		expect(o).toMatchObject({ status: "processing", paymentStatus: "paid", stock: "deducted" });
		expect(o.awaitingAsyncPayment).toBeUndefined();
		expect(onHand(t, "s1")).toBe(7);
		expect(t.carts.rows.has(o.cartId)).toBe(false);

		await deliver(t, "checkout.session.async_payment_succeeded", session(co, "paid"));
		expect(onHand(t, "s1")).toBe(7);
	});

	test("a failed delayed payment fails the order without touching stock", async () => {
		const t = shop();
		const co = await checkedOut(t);
		await deliver(t, "checkout.session.completed", session(co, "unpaid"));
		const failed = await deliver(t, "checkout.session.async_payment_failed", session(co, "unpaid"));
		expect(failed.body).toMatchObject({ outcome: "failed" });
		const o = await order(t, co.orderId);
		expect(o).toMatchObject({ status: "failed", paymentStatus: "failed" });
		expect(o.awaitingAsyncPayment).toBeUndefined();
		expect(onHand(t, "s1")).toBeUndefined();
	});

	test("the merchant can only cancel an order waiting for payment", async () => {
		const t = shop();
		const co = await checkedOut(t);
		await deliver(t, "checkout.session.completed", session(co, "unpaid"));
		const act = (to: string) =>
			handleAdmin(t.ctx, {
				type: "block_action",
				action_id: "set_status",
				value: `${co.orderId}:${to}`,
			});
		await act("processing");
		expect(await order(t, co.orderId)).toMatchObject({ status: "on-hold" });
		await act("cancelled");
		expect(await order(t, co.orderId)).toMatchObject({ status: "cancelled" });
	});
});

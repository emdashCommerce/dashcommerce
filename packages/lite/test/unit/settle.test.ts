/**
 * Deferred stock settle (settle.ts): orders too large for one request
 * finish in one-shot cron tasks, exactly once, also when a refund or a
 * cancel lands while the deduction is still running.
 */

import { describe, expect, test } from "bun:test";
import { handleAdmin } from "../../src/admin";
import { handleCron, runSweep } from "../../src/cron";
import type { LiteOrder } from "../../src/orders";
import { pendingLines, settleStock } from "../../src/settle";
import type { StockRow } from "../../src/stock";
import { makeCtx, product } from "../helpers/fake-ctx";
import {
	addToCart,
	checkout,
	okStripe,
	pay,
	refund,
	runSettleTasks,
	SK,
	WH,
} from "../helpers/flow";

function shop(lines = 12) {
	const products = Array.from({ length: lines }, (_, i) =>
		product(`s${i}`, { manage_stock: 1, stock_quantity: 10 }),
	);
	const t = makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH, cronVersion: 2 },
		products,
		stripe: okStripe,
	});
	return { t, ids: products.map((p) => p.id) };
}
type Shop = ReturnType<typeof shop>["t"];
const onHand = (t: Shop, id: string) =>
	(t.stock.rows.get(id)?.data as StockRow | undefined)?.onHand;
const order = (t: Shop, id: string) => t.orders.rows.get(id)?.data as unknown as LiteOrder;

async function paidOrder(t: Shop, ids: string[]) {
	const co = await checkout(
		t,
		await addToCart(
			t,
			ids.map((id) => [id, 2] as [string, number]),
		),
	);
	const res = await pay(t, co);
	return { co, res };
}

describe("deferred stock settle", () => {
	test("a 12-line paid order: webhook takes 1 line, tasks take the rest", async () => {
		const { t, ids } = shop(12);
		const { co, res } = await paidOrder(t, ids);
		expect(res.body).toMatchObject({ outcome: "paid_stock_pending" });
		expect(order(t, co.orderId)).toMatchObject({ paymentStatus: "paid", stockPending: 1 });
		expect(order(t, co.orderId).paidEffectsAt).toBeUndefined();
		expect(ids.filter((id) => onHand(t, id) === 8)).toHaveLength(1);
		expect([...t.cronTasks.keys()]).toEqual([`stock-${co.orderId}-1`]);

		await runSettleTasks(t);
		for (const id of ids) expect(onHand(t, id)).toBe(8);
		const o = order(t, co.orderId);
		expect(o.stockPending).toBeUndefined();
		expect(o.paidEffectsAt).toBeString();
		expect(Object.values(o.stockMoves ?? {}).every((m) => m.state === "deducted")).toBe(true);

		// A second run of a stale task changes nothing.
		await handleCron(
			{ name: `stock-${co.orderId}-9`, data: { orderId: co.orderId, pass: 9 }, scheduledAt: "" },
			t.ctx,
		);
		for (const id of ids) expect(onHand(t, id)).toBe(8);
	});

	test("a full refund while the deduction is still running ends with all stock back", async () => {
		const { t, ids } = shop(12);
		const { co } = await paidOrder(t, ids);
		// One settle task ran, then the refund arrives.
		const [first] = [...t.cronTasks.entries()];
		if (!first) throw new Error("no task");
		await handleCron({ name: first[0], data: first[1].data, scheduledAt: "" }, t.ctx);
		t.cronTasks.delete(first[0]);
		const ref = await refund(t, co.orderId, co.total, co.total);
		expect(ref.status).toBe(200);
		await runSettleTasks(t);
		// Never-taken lines have no stock row; their product value (10) applies.
		for (const id of ids) expect(onHand(t, id) ?? 10).toBe(10);
		const o = order(t, co.orderId);
		expect(o.stock).toBe("restored");
		expect(o.stockPending).toBeUndefined();
		expect(pendingLines(o)).toHaveLength(0);
		// Lines never taken are recorded as skipped, the rest as restored.
		const states = new Set(Object.values(o.stockMoves ?? {}).map((m) => m.state));
		for (const s of states) expect(["restored", "skipped"]).toContain(s);
	});

	test("admin cancel during the deduction converges to all stock back", async () => {
		const { t, ids } = shop(12);
		const { co } = await paidOrder(t, ids);
		await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "set_status",
			value: `${co.orderId}:cancelled`,
		});
		await runSettleTasks(t);
		// Never-taken lines have no stock row; their product value (10) applies.
		for (const id of ids) expect(onHand(t, id) ?? 10).toBe(10);
		expect(order(t, co.orderId).stockPending).toBeUndefined();
	});

	test("a stock row write that loses a race is retried by the next pass", async () => {
		const { t, ids } = shop(3);
		const { co } = await paidOrder(t, ids.slice(0, 1));
		expect(onHand(t, ids[0] as string)).toBe(8);
		// Another order changes the row between this pass's read and write.
		const co2 = await checkout(t, await addToCart(t, [[ids[0] as string, 1]]));
		const stock = t.stock as unknown as { updateIf: (...a: unknown[]) => Promise<unknown> };
		const original = stock.updateIf.bind(t.stock);
		let raced = false;
		stock.updateIf = async (...args: unknown[]) => {
			if (!raced) {
				raced = true;
				const row = (await t.stock.get(ids[0] as string)) as unknown as StockRow;
				await t.stock.put(ids[0] as string, {
					...row,
					onHand: row.onHand - 5,
					rev: (row.rev ?? 0) + 1,
				});
			}
			return original(...args);
		};
		const res = await pay(t, co2);
		expect(res.body).toMatchObject({ outcome: "paid_stock_pending" });
		stock.updateIf = original;
		await runSettleTasks(t);
		expect(onHand(t, ids[0] as string)).toBe(2); // 10 - 2 - 5 - 1
		expect(order(t, co.orderId).stockPending).toBeUndefined();
		expect(order(t, co2.orderId).stockPending).toBeUndefined();
	});

	test("the sweep re-schedules orders whose settle task was lost", async () => {
		const { t, ids } = shop(12);
		const { co } = await paidOrder(t, ids);
		t.cronTasks.clear(); // the follow-up task is gone
		expect(await runSweep(t.ctx)).toBe(1);
		expect([...t.cronTasks.keys()]).toEqual([`stock-${co.orderId}-sweep`]);
		await runSettleTasks(t);
		for (const id of ids) expect(onHand(t, id)).toBe(8);
	});

	test("settleStock never exceeds the calls left", async () => {
		const { t, ids } = shop(12);
		const { co } = await paidOrder(t, ids);
		t.calls.count = 0;
		const { metered } = await import("../../src/budget");
		const ctx = metered(t.ctx, 4);
		await settleStock(ctx, co.orderId);
		expect(t.calls.count).toBeLessThanOrEqual(4);
	});
});

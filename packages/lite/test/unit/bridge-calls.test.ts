/**
 * Subrequest budget. On Cloudflare a sandboxed invocation gets 10
 * subrequests, and every `ctx.*` bridge call (storage, content, settings,
 * kv, cron, log, http) counts. The fake context counts every one of them
 * independently of the plugin's own meter (budget.ts). These tests assert
 * that each request path stays within 10 at 1, 5, 10 and 20 cart lines,
 * and that the deferred stock work converges to the right stock levels.
 */

import { describe, expect, test } from "bun:test";
import { handleAdmin } from "../../src/admin";
import { CART_HEADER } from "../../src/cart";
import { addItemHandler, getCartHandler } from "../../src/cart-routes";
import { createCheckoutHandler } from "../../src/checkout";
import { handleCron, runCleanup } from "../../src/cron";
import type { LiteOrder } from "../../src/orders";
import type { StockRow } from "../../src/stock";
import { makeCtx, product } from "../helpers/fake-ctx";
import {
	addToCart,
	countCalls,
	deliver,
	okStripe,
	refund,
	runSettleTasks,
	SK,
	WH,
} from "../helpers/flow";

const BUDGET = 10;
const SIZES = [1, 5, 10, 20];

function shop(opts: { lines: number; tracked: boolean; catalog?: number }) {
	const catalog = Math.max(opts.catalog ?? opts.lines, opts.lines);
	const products = Array.from({ length: catalog }, (_, i) =>
		product(
			`p${String(i).padStart(4, "0")}`,
			opts.tracked ? { manage_stock: 1, stock_quantity: 50 } : {},
		),
	);
	const t = makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH, cronVersion: 2 },
		products,
		stripe: okStripe,
	});
	// Cart lines: spread over the catalog so a large catalog needs lookups.
	const step = Math.floor(catalog / opts.lines);
	const ids = Array.from({ length: opts.lines }, (_, i) => products[i * step]?.id as string);
	return { t, ids };
}
type Shop = ReturnType<typeof shop>["t"];

/** Check out with the storefront kit's retry loop; returns calls per request. */
async function checkoutCounted(t: Shop, token: string) {
	const counts: number[] = [];
	for (let i = 0; i < 10; i += 1) {
		const { calls, result } = await countCalls(t, () =>
			createCheckoutHandler(t.ctx, { [CART_HEADER]: token }, {}),
		);
		counts.push(calls);
		const res = result as { ok: boolean; orderId?: string; error?: { code: string } };
		if (res.ok) {
			const order = (await t.orders.get(res.orderId as string)) as unknown as LiteOrder;
			return {
				counts,
				orderId: res.orderId as string,
				sessionId: order.stripeSessionId as string,
				total: order.total.amount,
			};
		}
		if (res.error?.code !== "CHECKOUT_CONTINUE") throw new Error(`checkout: ${res.error?.code}`);
	}
	throw new Error("checkout did not finish");
}

function session(co: { orderId: string; sessionId: string; total: number }, status: string) {
	return {
		id: co.sessionId,
		object: "checkout.session",
		client_reference_id: co.orderId,
		metadata: { orderId: co.orderId },
		payment_status: status,
		amount_total: co.total,
		currency: "usd",
		payment_intent: `pi_${co.orderId}`,
		customer_details: { email: "buyer@example.com" },
	};
}

const onHand = (t: Shop, id: string) =>
	(t.stock.rows.get(id)?.data as StockRow | undefined)?.onHand;
const order = (t: Shop, id: string) => t.orders.rows.get(id)?.data as unknown as LiteOrder;

describe("every request stays within the subrequest budget", () => {
	for (const lines of SIZES) {
		for (const tracked of [false, true]) {
			test(`${lines} lines, ${tracked ? "stock-tracked" : "untracked"}: checkout, card paid, refund`, async () => {
				const { t, ids } = shop({ lines, tracked });
				const token = await addToCart(
					t,
					ids.map((id) => [id, 2] as [string, number]),
				);
				const co = await checkoutCounted(t, token);
				expect(co.counts.length).toBe(1); // small catalog: one list call
				for (const c of co.counts) expect(c).toBeLessThanOrEqual(BUDGET);

				const paid = await countCalls(t, () =>
					deliver(t, "checkout.session.completed", session(co, "paid")),
				);
				expect(paid.calls).toBeLessThanOrEqual(BUDGET);
				expect(paid.result.status).toBe(200);
				const tasks = await runSettleTasks(t);
				for (const c of tasks) expect(c).toBeLessThanOrEqual(BUDGET);
				expect(order(t, co.orderId).paidEffectsAt).toBeString();
				expect(order(t, co.orderId).stockPending).toBeUndefined();
				if (tracked) for (const id of ids) expect(onHand(t, id)).toBe(48);

				const ref = await countCalls(t, () => refund(t, co.orderId, co.total, co.total));
				expect(ref.calls).toBeLessThanOrEqual(BUDGET);
				expect(ref.result.status).toBe(200);
				for (const c of await runSettleTasks(t)) expect(c).toBeLessThanOrEqual(BUDGET);
				if (tracked) for (const id of ids) expect(onHand(t, id)).toBe(50);
				expect(order(t, co.orderId).stockPending).toBeUndefined();
			});

			test(`${lines} lines, ${tracked ? "stock-tracked" : "untracked"}: delayed payment succeeded`, async () => {
				const { t, ids } = shop({ lines, tracked });
				const token = await addToCart(
					t,
					ids.map((id) => [id, 1] as [string, number]),
				);
				const co = await checkoutCounted(t, token);
				const held = await countCalls(t, () =>
					deliver(t, "checkout.session.completed", session(co, "unpaid")),
				);
				expect(held.calls).toBeLessThanOrEqual(BUDGET);
				const ok = await countCalls(t, () =>
					deliver(t, "checkout.session.async_payment_succeeded", session(co, "paid")),
				);
				expect(ok.calls).toBeLessThanOrEqual(BUDGET);
				for (const c of await runSettleTasks(t)) expect(c).toBeLessThanOrEqual(BUDGET);
				if (tracked) for (const id of ids) expect(onHand(t, id)).toBe(49);
				expect(order(t, co.orderId).paidEffectsAt).toBeString();
			});

			test(`${lines} lines, ${tracked ? "stock-tracked" : "untracked"}: large catalog checkout`, async () => {
				const { t, ids } = shop({ lines, tracked, catalog: 1000 });
				const token = await addToCart(
					t,
					ids.map((id) => [id, 1] as [string, number]),
				);
				const co = await checkoutCounted(t, token);
				for (const c of co.counts) expect(c).toBeLessThanOrEqual(BUDGET);
				expect(co.counts.length).toBeLessThanOrEqual(4);
				expect(order(t, co.orderId).items).toHaveLength(lines);
			});
		}
	}

	test("admin cancel of a 20-line paid order stays within budget and restores all stock", async () => {
		const { t, ids } = shop({ lines: 20, tracked: true });
		const co = await checkoutCounted(
			t,
			await addToCart(
				t,
				ids.map((id) => [id, 1] as [string, number]),
			),
		);
		await deliver(t, "checkout.session.completed", session(co, "paid"));
		await runSettleTasks(t);
		const cancel = await countCalls(t, () =>
			handleAdmin(t.ctx, {
				type: "block_action",
				action_id: "set_status",
				value: `${co.orderId}:cancelled`,
			}),
		);
		expect(cancel.calls).toBeLessThanOrEqual(BUDGET);
		for (const c of await runSettleTasks(t)) expect(c).toBeLessThanOrEqual(BUDGET);
		for (const id of ids) expect(onHand(t, id)).toBe(50);
	});

	test("cart routes, cleanup, sweep and admin pages", async () => {
		const { t, ids } = shop({ lines: 3, tracked: true });
		const token = await addToCart(
			t,
			ids.slice(0, 2).map((id) => [id, 1] as [string, number]),
		);
		expect((await countCalls(t, () => getCartHandler(t.ctx, { [CART_HEADER]: token }))).calls).toBe(
			2,
		);
		expect(
			(
				await countCalls(t, () =>
					addItemHandler(t.ctx, { [CART_HEADER]: token }, { productId: ids[2] }),
				)
			).calls,
		).toBe(5); // settings, cart, content, stock row, cart put
		const cleanup = await countCalls(t, () => runCleanup(t.ctx, Date.now() + 90 * 86_400_000));
		expect(cleanup.calls).toBeLessThanOrEqual(BUDGET);
		const sweep = await countCalls(t, () =>
			handleCron(
				{ name: "stock-sweep", scheduledAt: "" } as Parameters<typeof handleCron>[0],
				t.ctx,
			),
		);
		expect(sweep.calls).toBeLessThanOrEqual(BUDGET);
		for (const page of ["/orders", "/stock", "/settings", "widget:recent-orders"]) {
			const res = await countCalls(t, () => handleAdmin(t.ctx, { type: "page_load", page }));
			expect(res.calls).toBeLessThanOrEqual(BUDGET);
		}
	});

	test("the cleanup cron is scheduled lazily when the install hook never ran", async () => {
		const t = makeCtx({ settings: { stripeSecretKey: SK }, products: [product("a")] });
		const first = await countCalls(t, () => getCartHandler(t.ctx, {}));
		expect(first.calls).toBe(4); // settings + 2 schedules + cronVersion write
		expect([...t.cronTasks.keys()].sort()).toEqual(["cleanup", "stock-sweep"]);
		expect(t.settings.get("cronVersion")).toBe(2);
		expect((await countCalls(t, () => getCartHandler(t.ctx, {}))).calls).toBe(1);
	});
});

describe("cleanup with many stale orders", () => {
	test("cancels at most 3 per run and stays within budget", async () => {
		const t = makeCtx({ settings: { stripeSecretKey: SK } });
		const old = new Date(Date.now() - 48 * 3600_000).toISOString();
		for (let i = 0; i < 12; i += 1) {
			await t.orders.put(`o${i}`, { status: "pending", paymentStatus: "pending", createdAt: old });
			await t.carts.put(`c${i}`, { cart: {}, expiresAt: old });
			await t.stripeEvents.put(`e${i}`, { createdAt: "2000-01-01T00:00:00.000Z" });
		}
		const run = await countCalls(t, () => runCleanup(t.ctx));
		expect(run.calls).toBeLessThanOrEqual(BUDGET);
		expect(run.result.orders).toBe(3);
	});
});

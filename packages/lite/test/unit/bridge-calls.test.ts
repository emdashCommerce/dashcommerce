/**
 * Subrequest budget. On Cloudflare a sandboxed invocation gets 10
 * subrequests, and every `ctx.*` bridge call (storage, content, settings,
 * kv, cron, log, http) counts. Lite keeps 2 of them as headroom and allows
 * itself 8. The fake context counts every call independently of the
 * plugin's own meter (budget.ts). These tests assert that every invocation
 * (route, webhook, cron task, admin action) stays within 8 at 1, 5, 10 and
 * 20 cart lines, including replays, early refunds, delayed payments and
 * catalogs larger than one list page, and that the deferred stock work
 * converges to the right stock levels within 2 cron ticks.
 */

import { describe, expect, test } from "bun:test";
import { handleAdmin } from "../../src/admin";
import { CART_HEADER } from "../../src/cart";
import {
	addItemHandler,
	clearCartHandler,
	getCartHandler,
	updateItemHandler,
} from "../../src/cart-routes";
import { createCheckoutHandler } from "../../src/checkout";
import { handleExport } from "../../src/export";
import { HEADROOM, SANDBOX_SUBREQUEST_CAP, SUBREQUEST_BUDGET } from "../../src/budget";
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
	runSettleTicks,
	SK,
	WH,
} from "../helpers/flow";

const BUDGET = 8;
const SIZES = [1, 5, 10, 20];
/** Checkout requests the storefront kit may need for a 20-line cart. */
const MAX_CHECKOUT_REQUESTS = 5;

test("the plugin's own budget keeps 2 calls of headroom under the cap", () => {
	expect(SANDBOX_SUBREQUEST_CAP).toBe(10);
	expect(HEADROOM).toBe(2);
	expect(SUBREQUEST_BUDGET).toBe(BUDGET);
});

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
					deliver(t, "checkout.session.completed", session(co, "paid"), `evt_paid_${lines}`),
				);
				expect(paid.calls).toBeLessThanOrEqual(BUDGET);
				expect(paid.result.status).toBe(200);
				const settle = await runSettleTicks(t);
				for (const c of settle.counts) expect(c).toBeLessThanOrEqual(BUDGET);
				expect(settle.ticks).toBeLessThanOrEqual(2);
				expect(order(t, co.orderId).paidEffectsAt).toBeString();

				// Replays: the same event id, and a new id for the same session.
				for (const id of [`evt_paid_${lines}`, undefined]) {
					const replay = await countCalls(t, () =>
						deliver(t, "checkout.session.completed", session(co, "paid"), id),
					);
					expect(replay.calls).toBeLessThanOrEqual(BUDGET);
					expect(replay.result.status).toBe(200);
				}
				expect(order(t, co.orderId).stockPending).toBeUndefined();
				if (tracked) for (const id of ids) expect(onHand(t, id)).toBe(48);

				// A charge without metadata: the order is found by its PaymentIntent.
				const partial = await countCalls(t, () =>
					refund(t, co.orderId, co.total, 100, { metadata: false }),
				);
				expect(partial.calls).toBeLessThanOrEqual(BUDGET);
				const ref = await countCalls(t, () =>
					refund(t, co.orderId, co.total, co.total, { id: `evt_ref_${lines}`, metadata: false }),
				);
				expect(ref.calls).toBeLessThanOrEqual(BUDGET);
				expect(ref.result.status).toBe(200);
				const restore = await runSettleTicks(t);
				for (const c of restore.counts) expect(c).toBeLessThanOrEqual(BUDGET);
				expect(restore.ticks).toBeLessThanOrEqual(2);
				const again = await countCalls(t, () =>
					refund(t, co.orderId, co.total, co.total, { id: `evt_ref_${lines}` }),
				);
				expect(again.calls).toBeLessThanOrEqual(BUDGET);
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
				// A refund before the payment: 500 so Stripe retries.
				const early = await countCalls(t, () => refund(t, co.orderId, co.total, co.total));
				expect(early.calls).toBeLessThanOrEqual(BUDGET);
				expect(early.result.status).toBe(500);
				const held = await countCalls(t, () =>
					deliver(t, "checkout.session.completed", session(co, "unpaid")),
				);
				expect(held.calls).toBeLessThanOrEqual(BUDGET);
				expect(order(t, co.orderId)).toMatchObject({
					status: "on-hold",
					awaitingAsyncPayment: true,
				});
				const sweep = await countCalls(t, () => runCleanup(t.ctx, Date.now() + 4 * 86_400_000));
				expect(sweep.calls).toBeLessThanOrEqual(BUDGET);
				expect(order(t, co.orderId).status).toBe("on-hold");
				const ok = await countCalls(t, () =>
					deliver(t, "checkout.session.async_payment_succeeded", session(co, "paid")),
				);
				expect(ok.calls).toBeLessThanOrEqual(BUDGET);
				for (const c of await runSettleTasks(t)) expect(c).toBeLessThanOrEqual(BUDGET);
				if (tracked) for (const id of ids) expect(onHand(t, id)).toBe(49);
				expect(order(t, co.orderId).paidEffectsAt).toBeString();
			});

			for (const catalog of [146, 1000]) {
				test(`${lines} lines, ${tracked ? "stock-tracked" : "untracked"}: ${catalog}-product catalog checkout`, async () => {
					const { t, ids } = shop({ lines, tracked, catalog });
					const token = await addToCart(
						t,
						ids.map((id) => [id, 1] as [string, number]),
					);
					const co = await checkoutCounted(t, token);
					for (const c of co.counts) expect(c).toBeLessThanOrEqual(BUDGET);
					expect(co.counts.length).toBeLessThanOrEqual(MAX_CHECKOUT_REQUESTS);
					expect(order(t, co.orderId).items).toHaveLength(lines);
				});
			}
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
		const restore = await runSettleTicks(t);
		for (const c of restore.counts) expect(c).toBeLessThanOrEqual(BUDGET);
		expect(restore.ticks).toBeLessThanOrEqual(2);
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

describe("admin actions, other webhooks and the CSV export", () => {
	test("every admin action stays within budget, worst cases included", async () => {
		const products = Array.from({ length: 30 }, (_, i) =>
			product(`q${i}`, { manage_stock: 1, stock_quantity: 5 }),
		);
		const t = makeCtx({ settings: { cronVersion: 2 }, products, stripe: okStripe });
		const counted = async (input: unknown) => {
			const res = await countCalls(t, () => handleAdmin(t.ctx, input));
			expect(res.calls).toBeLessThanOrEqual(BUDGET);
			return res.result;
		};
		// First settings save: 9 changed values.
		await counted({
			type: "form_submit",
			action_id: "save_settings",
			values: {
				stripeSecretKey: SK,
				stripeWebhookSecret: WH,
				currency: "eur",
				successUrl: "/ok",
				cancelUrl: "/no",
				shippingCountries: "US,GB",
				flatShipping: "4.99",
				flatTaxPercent: "8",
				automaticTax: false,
			},
		});
		const co = await checkoutCounted(t, await addToCart(t, [["q1", 1]]));
		await deliver(t, "checkout.session.completed", session(co, "paid"));
		await runSettleTasks(t);
		for (let i = 0; i < 1000; i += 1) {
			await t.orders.put(`x${i}`, {
				status: "pending",
				paymentStatus: "pending",
				orderNumber: `N${i}`,
				currency: "EUR",
				items: [],
				subtotal: { currency: "EUR", amount: 1 },
				total: { currency: "EUR", amount: 1 },
				createdAt: new Date(2020, 0, 1, 0, i).toISOString(),
			});
		}
		// 29 rows to create: each sync click writes what fits.
		for (let i = 0; i < 7; i += 1) {
			await counted({ type: "block_action", action_id: "sync_stock" });
		}
		expect(t.stock.rows.size).toBe(30);
		await counted({ type: "block_action", action_id: "view_order", value: co.orderId });
		await counted({ type: "block_action", action_id: "orders_page:", value: undefined });
		await counted({ type: "block_action", action_id: "filter_status", value: "pending" });
		await counted({ type: "block_action", action_id: "stock_page" });
		await counted({ type: "block_action", action_id: "adjust_stock", value: "q1" });
		await counted({
			type: "form_submit",
			action_id: "save_stock",
			block_id: "stock-adjust:q1",
			values: { onHand: 9 },
		});
		await counted({ type: "form_submit", action_id: "search_orders", values: { q: "N5" } });
		await counted({
			type: "block_action",
			action_id: "set_status",
			value: `${co.orderId}:completed`,
		});
		const exported = await counted({ type: "block_action", action_id: "export_csv", value: "" });
		await counted({ type: "block_action", action_id: "clear_webhook_secret" });

		const token = JSON.stringify(exported).match(/orders\/export\?token=([A-Za-z0-9_-]+)/)?.[1];
		expect(token).toBeString();
		const csv = await countCalls(t, () => handleExport(t.ctx, { token }));
		expect(csv.calls).toBeLessThanOrEqual(BUDGET);
		expect(csv.result.status).toBe(200);
		expect(csv.result.headers["x-dashcommerce-truncated"]).toBe("true");
	});

	test("expired and failed delayed-payment webhooks, cart edits", async () => {
		const { t, ids } = shop({ lines: 20, tracked: true });
		const token = await addToCart(
			t,
			ids.map((id) => [id, 1] as [string, number]),
		);
		const cart = (await getCartHandler(t.ctx, { [CART_HEADER]: token })) as {
			cart: { items: Array<{ lineId: string }> };
		};
		const lineId = cart.cart.items[0]?.lineId as string;
		const upd = await countCalls(t, () =>
			updateItemHandler(t.ctx, { [CART_HEADER]: token }, { lineId, quantity: 3 }),
		);
		expect(upd.calls).toBeLessThanOrEqual(BUDGET);
		const co = await checkoutCounted(t, token);
		const held = await countCalls(t, () =>
			deliver(t, "checkout.session.completed", session(co, "unpaid")),
		);
		expect(held.calls).toBeLessThanOrEqual(BUDGET);
		const failed = await countCalls(t, () =>
			deliver(t, "checkout.session.async_payment_failed", session(co, "unpaid")),
		);
		expect(failed.calls).toBeLessThanOrEqual(BUDGET);
		expect(order(t, co.orderId).status).toBe("failed");

		const co2 = await checkoutCounted(t, await addToCart(t, [[ids[0] as string, 1]]));
		const expired = await countCalls(t, () =>
			deliver(t, "checkout.session.expired", session(co2, "unpaid")),
		);
		expect(expired.calls).toBeLessThanOrEqual(BUDGET);
		expect(order(t, co2.orderId).status).toBe("cancelled");
		const clear = await countCalls(t, () => clearCartHandler(t.ctx, { [CART_HEADER]: token }));
		expect(clear.calls).toBeLessThanOrEqual(BUDGET);
	});
});

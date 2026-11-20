/**
 * Providers whose refunds settle later (Paystack: pending → processing →
 * processed, sometimes days) report each change as a normalised
 * `refund.updated` event, which moves the stored refund on.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext } from "emdash";
import { refundOrder } from "../src/orders/refund";
import {
	createMockPaymentProvider,
	type NormalizedPaymentEvent,
	type PaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import type { Order, Refund } from "../src/types";
import { deliverWebhook, makeRouteContext, startCheckout } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const settings = {
	"settings:paymentProvider": "acme",
	"settings:checkoutMode": "hosted",
	"settings:acmeSecretKey": "acme-key",
	"settings:acmeWebhookSecret": "test-secret",
};
const headers = { "x-acme-signature": "signed" };

/** Mock provider whose refunds start pending and which reports refund.updated. */
function acme(): PaymentProvider {
	const base = createMockPaymentProvider({ id: "acme" });
	return {
		...base,
		async refund(ctx, input, creds) {
			const result = await base.refund(ctx, input, creds);
			return { ...result, status: "pending" };
		},
		parseWebhookEvent(raw): NormalizedPaymentEvent {
			const event = JSON.parse(raw) as {
				type: string;
				refundId?: string;
				status?: "pending" | "succeeded" | "failed";
			};
			if (event.type === "refund.updated" && event.refundId && event.status) {
				return {
					type: "refund.updated",
					providerId: "acme",
					providerEventId: "",
					providerRefundId: event.refundId,
					status: event.status,
					raw: event,
				};
			}
			return base.parseWebhookEvent(raw);
		},
	};
}

async function paidOrderWithPendingRefund(amount = 50000): Promise<{
	ctx: PluginContext;
	getCol: (name: string) => Map<string, Record<string, unknown>>;
	logs: Array<{ level: string; msg: string }>;
	refund: Refund;
	order: Order;
}> {
	registerPaymentProvider(acme());
	const { ctx, getCol, logs } = makeRouteContext(settings);
	const draftId = await startCheckout(ctx, `sess_${Math.random()}`);
	const paid = await deliverWebhook(
		ctx,
		JSON.stringify({
			id: `evt_${draftId}`,
			type: "charge.succeeded",
			orderDraftId: draftId,
			paymentReference: `pay_${draftId}`,
			amount: 150000,
			currency: "KES",
		}),
		headers,
	);
	expect(paid.status).toBe(200);
	const order = Array.from(getCol("orders").values())[0] as unknown as Order;
	const refund = await refundOrder(ctx, {
		orderId: order.id,
		amount: { amount, currency: "KES" },
		idempotencyKey: "refund:test:1",
	});
	expect(refund.status).toBe("pending");
	return { ctx, getCol, logs, refund, order };
}

function orderRow(getCol: (n: string) => Map<string, Record<string, unknown>>, id: string) {
	return getCol("orders").get(id) as unknown as Order;
}

function refundRow(getCol: (n: string) => Map<string, Record<string, unknown>>, id: string) {
	return getCol("refunds").get(id) as unknown as Refund;
}

function update(refundId: string, status: "pending" | "succeeded" | "failed"): string {
	return JSON.stringify({ type: "refund.updated", refundId, status });
}

describe("refund.updated", () => {
	it("marks a pending refund succeeded", async () => {
		const { ctx, getCol, refund } = await paidOrderWithPendingRefund();
		const res = await deliverWebhook(ctx, update(refund.stripeRefundId, "succeeded"), headers);
		expect(res.status).toBe(200);
		expect(refundRow(getCol, refund.id).status).toBe("succeeded");
	});

	it("marks a pending refund failed and tells the operator", async () => {
		const { ctx, getCol, logs, refund } = await paidOrderWithPendingRefund();
		const res = await deliverWebhook(ctx, update(refund.stripeRefundId, "failed"), headers);
		expect(res.status).toBe(200);
		expect(refundRow(getCol, refund.id).status).toBe("failed");
		expect(logs.some((l) => l.level === "error" && /refund failed/i.test(l.msg))).toBe(true);
	});

	it("never moves a settled refund back to pending", async () => {
		const { ctx, getCol, refund } = await paidOrderWithPendingRefund();
		await deliverWebhook(ctx, update(refund.stripeRefundId, "succeeded"), headers);
		const res = await deliverWebhook(ctx, update(refund.stripeRefundId, "pending"), headers);
		expect(res.status).toBe(200);
		expect(refundRow(getCol, refund.id).status).toBe("succeeded");
	});

	it("ignores a refund it does not know, with a warning", async () => {
		const { ctx, logs } = await paidOrderWithPendingRefund();
		const res = await deliverWebhook(ctx, update("refund_unknown", "succeeded"), headers);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { orphan?: boolean }).orphan).toBe(true);
		expect(logs.some((l) => l.level === "warn" && /unknown refund/i.test(l.msg))).toBe(true);
	});

	it("ignores an update for a refund that belongs to another provider's order", async () => {
		const { ctx, getCol, refund } = await paidOrderWithPendingRefund();
		const orders = getCol("orders");
		const [orderId, order] = Array.from(orders.entries())[0] ?? [];
		if (!orderId || !order) throw new Error("no order");
		orders.set(orderId, { ...order, providerId: "stripe" });

		const res = await deliverWebhook(ctx, update(refund.stripeRefundId, "succeeded"), headers);
		expect(res.status).toBe(200);
		expect(refundRow(getCol, refund.id).status).toBe("pending");
	});
});

describe("a failed refund stops counting against the order", () => {
	it("restores the order's refunded total and statuses when the only refund fails", async () => {
		const { ctx, getCol, refund, order } = await paidOrderWithPendingRefund(150000);
		expect(orderRow(getCol, order.id).paymentStatus).toBe("refunded");
		expect(orderRow(getCol, order.id).status).toBe("refunded");

		const res = await deliverWebhook(ctx, update(refund.stripeRefundId, "failed"), headers);
		expect(res.status).toBe(200);
		const after = orderRow(getCol, order.id);
		expect(after.refundedTotal.amount).toBe(0);
		expect(after.paymentStatus).toBe("paid");
		expect(after.status).toBe(order.status);
		expect(refundRow(getCol, refund.id).orderStatusBefore).toBe(order.status);
	});

	it("keeps the other refunds counted when one of two fails", async () => {
		const { ctx, getCol, refund, order } = await paidOrderWithPendingRefund(50000);
		const second = await refundOrder(ctx, {
			orderId: order.id,
			amount: { amount: 30000, currency: "KES" },
			idempotencyKey: "refund:test:2",
		});
		expect(orderRow(getCol, order.id).refundedTotal.amount).toBe(80000);

		await deliverWebhook(ctx, update(refund.stripeRefundId, "failed"), headers);
		const after = orderRow(getCol, order.id);
		expect(after.refundedTotal.amount).toBe(30000);
		expect(after.paymentStatus).toBe("partially-refunded");
		expect(after.status).toBe("partially-refunded");
		expect(refundRow(getCol, second.id).status).toBe("pending");
	});

	it("goes back to the status the order had before its first refund when all refunds fail", async () => {
		const { ctx, getCol, refund, order } = await paidOrderWithPendingRefund(50000);
		const second = await refundOrder(ctx, {
			orderId: order.id,
			amount: { amount: 30000, currency: "KES" },
			idempotencyKey: "refund:test:2",
		});
		await deliverWebhook(ctx, update(second.stripeRefundId, "failed"), headers);
		await deliverWebhook(ctx, update(refund.stripeRefundId, "failed"), headers);
		const after = orderRow(getCol, order.id);
		expect(after.refundedTotal.amount).toBe(0);
		expect(after.paymentStatus).toBe("paid");
		expect(after.status).toBe(order.status);
	});

	it("does not reverse a refund twice", async () => {
		const { ctx, getCol, refund, order } = await paidOrderWithPendingRefund(50000);
		await deliverWebhook(ctx, update(refund.stripeRefundId, "failed"), headers);
		await deliverWebhook(ctx, update(refund.stripeRefundId, "failed"), headers);
		expect(orderRow(getCol, order.id).refundedTotal.amount).toBe(0);
	});

	it("never counts a refund the provider fails straight away", async () => {
		registerPaymentProvider({
			...acme(),
			async refund(ctx, input, creds) {
				const result = await createMockPaymentProvider({ id: "acme" }).refund(ctx, input, creds);
				return { ...result, status: "failed" };
			},
		});
		const { ctx, getCol } = makeRouteContext(settings);
		const draftId = await startCheckout(ctx, `sess_${Math.random()}`);
		await deliverWebhook(
			ctx,
			JSON.stringify({
				id: `evt_${draftId}`,
				type: "charge.succeeded",
				orderDraftId: draftId,
				paymentReference: `pay_${draftId}`,
				amount: 150000,
				currency: "KES",
			}),
			headers,
		);
		const order = Array.from(getCol("orders").values())[0] as unknown as Order;
		const refund = await refundOrder(ctx, {
			orderId: order.id,
			amount: { amount: 50000, currency: "KES" },
			idempotencyKey: "refund:test:failed-now",
		});
		expect(refund.status).toBe("failed");
		const after = orderRow(getCol, order.id);
		expect(after.refundedTotal.amount).toBe(0);
		expect(after.paymentStatus).toBe("paid");
	});
});

describe("stock put back by a refund that later fails", () => {
	/** Swap the harness's read-only catalogue for one that tracks stock. */
	function trackStock(ctx: PluginContext, start: number) {
		const data: Record<string, unknown> = {
			title: "Matchday ticket",
			type: "simple",
			prices: { KES: { amount: 150000 } },
			virtual: true,
			manage_stock: true,
			stock_quantity: start,
		};
		(ctx as unknown as { content: unknown }).content = {
			async get(collection: string, id: string) {
				return collection === "products" && id === "prod_ticket"
					? { id, status: "published", data }
					: null;
			},
			async update(_collection: string, _id: string, patch: Record<string, unknown>) {
				Object.assign(data, patch);
			},
		};
		return () => data.stock_quantity as number;
	}

	it("takes the stock back off, with a refund_failed ledger entry", async () => {
		registerPaymentProvider(acme());
		const { ctx, getCol, kvStore } = makeRouteContext(settings);
		// Stock-tracked checkout lists cart locks by key prefix.
		(ctx.kv as unknown as { list: unknown }).list = async (prefix: string) =>
			Array.from(kvStore.entries())
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, value]) => ({ key, value }));
		const stock = trackStock(ctx, 10);
		const draftId = await startCheckout(ctx, `sess_${Math.random()}`);
		await deliverWebhook(
			ctx,
			JSON.stringify({
				id: `evt_${draftId}`,
				type: "charge.succeeded",
				orderDraftId: draftId,
				paymentReference: `pay_${draftId}`,
				amount: 150000,
				currency: "KES",
			}),
			headers,
		);
		expect(stock()).toBe(9);
		const order = Array.from(getCol("orders").values())[0] as unknown as Order;
		const itemId = Array.from(getCol("order_items").keys())[0];
		expect(itemId).toBeTruthy();

		const refund = await refundOrder(ctx, {
			orderId: order.id,
			amount: { amount: 150000, currency: "KES" },
			idempotencyKey: "refund:test:restock",
			restock: true,
			lineItemRefunds: [
				{ orderItemId: itemId as string, quantity: 1, amount: { amount: 150000, currency: "KES" } },
			],
		});
		expect(stock()).toBe(10);

		await deliverWebhook(ctx, update(refund.stripeRefundId, "failed"), headers);
		expect(stock()).toBe(9);
		const ledger = Array.from(getCol("inventory_ledger").values()) as Array<{ reason: string }>;
		expect(ledger.map((e) => e.reason)).toContain("refund_failed");
	});
});

/**
 * A stable refund request id is the provider idempotency key. Retrying with
 * the same id must return the recorded refund and must not call the provider
 * again; a new attempt needs a new id.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { refundOrder } from "../src/orders/refund";
import {
	type PaymentProvider,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
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

async function paidOrder(): Promise<{
	ctx: PluginContext;
	getCol: (name: string) => Map<string, Record<string, unknown>>;
	calls: () => number;
	order: Order;
}> {
	let calls = 0;
	const base = createMockPaymentProvider({ id: "acme" });
	const provider: PaymentProvider = {
		...base,
		async refund(ctx, input, credentials) {
			calls += 1;
			if (!base.refund) throw new Error("mock refund missing");
			return base.refund(ctx, input, credentials);
		},
	};
	registerPaymentProvider(provider);

	const { ctx, getCol } = makeRouteContext(settings);
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
	return { ctx, getCol, calls: () => calls, order };
}

describe("refund idempotency", () => {
	it("returns the recorded refund and does not call the provider again", async () => {
		const { ctx, getCol, calls, order } = await paidOrder();

		const first = await refundOrder(ctx, {
			orderId: order.id,
			amount: { amount: 10_000, currency: "KES" },
			idempotencyKey: "refund:stable:1",
		});
		const second = await refundOrder(ctx, {
			orderId: order.id,
			amount: { amount: 10_000, currency: "KES" },
			idempotencyKey: "refund:stable:1",
		});

		expect(calls()).toBe(1);
		expect(second.id).toBe(first.id);
		expect(getCol("refunds").size).toBe(1);
	});

	it("treats a different request id as a new refund", async () => {
		const { ctx, getCol, calls, order } = await paidOrder();

		await refundOrder(ctx, {
			orderId: order.id,
			amount: { amount: 10_000, currency: "KES" },
			idempotencyKey: "refund:stable:1",
		});
		await refundOrder(ctx, {
			orderId: order.id,
			amount: { amount: 10_000, currency: "KES" },
			idempotencyKey: "refund:stable:2",
		});

		expect(calls()).toBe(2);
		expect(getCol("refunds").size).toBe(2);
	});

	it("replays a full refund through the admin route after losing the response", async () => {
		const { ctx, getCol, calls, order } = await paidOrder();
		const input = {
			amount: order.paidTotal.amount,
			currency: order.currency,
			reason: "Original reason",
			refundRequestId: "refund:full-balance",
		};
		const submit = () =>
			adminApiRoutes["admin/orders/refund"].handler(
				{
					request: new Request(`http://test/admin/orders/refund?id=${order.id}`, {
						method: "POST",
					}),
					input,
				} as RouteContext,
				ctx,
			);

		// The first response is lost after Core has recorded the refund.
		expect((await submit()).status).toBe(200);
		const retry = await submit();
		expect(retry.status).toBe(200);
		const { refund } = (await retry.json()) as { refund: Refund };
		expect(refund).toMatchObject({
			orderId: order.id,
			amount: order.paidTotal,
			reason: input.reason,
			refundRequestId: input.refundRequestId,
		});
		expect(calls()).toBe(1);
		expect(getCol("refunds").size).toBe(1);
		expect(getCol("orders").get(order.id)?.refundedTotal).toEqual(order.paidTotal);
	});

	it("rejects reuse of a request id for a different order", async () => {
		const { ctx, getCol, calls, order } = await paidOrder();
		const otherOrder = {
			...order,
			id: "other-order",
			orderNumber: "OTHER-1",
			stripePaymentIntentId: "pi_other",
			paymentReference: "pay_other",
		};
		getCol("orders").set(otherOrder.id, { ...otherOrder });
		const input = {
			orderId: order.id,
			amount: order.paidTotal,
			idempotencyKey: "refund:one-order",
		};
		await refundOrder(ctx, input);
		await expect(refundOrder(ctx, { ...input, orderId: otherOrder.id })).rejects.toThrow(
			/different order/i,
		);
		expect(calls()).toBe(1);
		expect(getCol("refunds").size).toBe(1);
	});

	it("rejects an empty request id", async () => {
		const { ctx, order } = await paidOrder();
		await expect(
			refundOrder(ctx, {
				orderId: order.id,
				amount: { amount: 10_000, currency: "KES" },
				idempotencyKey: "   ",
			}),
		).rejects.toThrow(/refundRequestId/i);
	});
});

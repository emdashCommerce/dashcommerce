/**
 * A stable refund request id is the provider idempotency key. Retrying with
 * the same id must return the recorded refund and must not call the provider
 * again; a new attempt needs a new id.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext } from "emdash";
import { refundOrder } from "../src/orders/refund";
import {
	type PaymentProvider,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import type { Order } from "../src/types";
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

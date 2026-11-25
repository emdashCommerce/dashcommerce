/**
 * A provider that cannot refund a split charge should be refused before the
 * call, with a message that points to its dashboard. Providers that do not
 * declare `splitRefunds: false` keep the existing behaviour.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { refundOrder } from "../src/orders/refund";
import {
	type NormalizedPaymentEvent,
	type PaymentProvider,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import type { Order, Vendor } from "../src/types";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const DRAFT_ID = "0123456789abcdef0123456789abcdef";

function vendor(id: string, reference: string): Vendor {
	return {
		id,
		name: `Vendor ${id}`,
		email: `${id}@example.com`,
		onboardingStatus: "active",
		platformFeePercent: 0,
		detailsSubmitted: false,
		chargesEnabled: false,
		payoutsEnabled: false,
		paymentAccounts: {
			flw: { accountReference: reference, status: "active", updatedAt: "2026-01-01T00:00:00Z" },
		},
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function splitEvent(): NormalizedPaymentEvent {
	return {
		type: "charge.succeeded",
		orderDraftId: DRAFT_ID,
		providerId: "flw",
		providerEventId: "evt_split_refund_1",
		checkoutReference: "dc-split",
		paymentReference: "pay_split_refund_1",
		amount: 150_000,
		currency: "KES",
		customer: { email: "supporter@example.com" },
		splitSettlement: {
			allocations: [
				{ accountReference: "RS_V1", amountMinor: 90_000 },
				{ accountReference: "RS_V2", amountMinor: 45_000 },
			],
			platformRemainderMinor: 7_650,
			providerFeeMinor: 7_350,
			currency: "KES",
			raw: { source: "test" },
		},
		raw: {},
	};
}

function provider(splitRefunds?: boolean): PaymentProvider {
	const base = createMockPaymentProvider({ id: "flw", capabilities: { splits: true } });
	return {
		...base,
		...(splitRefunds === undefined
			? {}
			: { capabilities: { ...base.capabilities, splitRefunds } }),
		webhookHeaders: ["verif-hash"],
		parseWebhookEvent: () => splitEvent(),
		async getPaymentStatus() {
			return {
				status: "succeeded",
				paymentReference: "pay_split_refund_1",
				amount: 150_000,
				currency: "KES",
			};
		},
	};
}

async function paidSplitOrder(providerImpl: PaymentProvider) {
	registerPaymentProvider(providerImpl);
	const { ctx, getCol } = makeRouteContext({
		"settings:paymentProvider": "flw",
		"settings:flwSecretKey": "test-key",
		"settings:flwWebhookSecret": "test-secret",
	});
	await ctx.kv.set(`draft:${DRAFT_ID}`, {
		cart: ticketCart("sess_split_refund"),
		ttlMs: 900_000,
		createdAt: new Date().toISOString(),
	});
	getCol("vendors").set("v1", vendor("v1", "RS_V1"));
	getCol("vendors").set("v2", vendor("v2", "RS_V2"));

	const request = new Request("http://test/checkout/webhook", {
		method: "POST",
		headers: { "verif-hash": "test-secret" },
		body: JSON.stringify({ split: true }),
	});
	const routeCtx = { ...ctx, request } as unknown as RouteContext;
	const res = (await sandbox.routes["checkout/webhook"].handler(routeCtx, ctx)) as Response;
	expect(res.status).toBe(200);
	const order = Array.from(getCol("orders").values())[0] as Order;
	expect(order.providerSplits).toBeTruthy();
	return { ctx, getCol, order };
}

describe("split refunds", () => {
	it("refuses before calling a provider that cannot refund splits", async () => {
		const { ctx, getCol, order } = await paidSplitOrder(provider(false));
		await expect(
			refundOrder(ctx as PluginContext, {
				orderId: order.id,
				amount: { amount: 10_000, currency: "KES" },
				idempotencyKey: "refund:split:1",
			}),
		).rejects.toThrow(/cannot refund split payments/i);
		expect(getCol("refunds").size).toBe(0);
	});

	it("keeps the existing behaviour when the provider does not declare a limit", async () => {
		const { ctx, getCol, order } = await paidSplitOrder(provider());
		const refund = await refundOrder(ctx as PluginContext, {
			orderId: order.id,
			amount: { amount: 10_000, currency: "KES" },
			idempotencyKey: "refund:split:2",
		});
		expect(refund.status).toBe("succeeded");
		expect(getCol("refunds").size).toBe(1);
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	type NormalizedPaymentEvent,
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
		providerEventId: "evt_split_1",
		checkoutReference: "dc-split",
		paymentReference: "pay_split_1",
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

function ctxWith(initialKv: Record<string, unknown>) {
	const harness = makeRouteContext(initialKv);
	const cart = ticketCart("sess_split");
	harness.ctx.kv.set(`draft:${DRAFT_ID}`, {
		cart,
		ttlMs: 900_000,
		createdAt: new Date().toISOString(),
	});
	harness.getCol("vendors").set("v1", vendor("v1", "RS_V1"));
	harness.getCol("vendors").set("v2", vendor("v2", "RS_V2"));
	return harness;
}

async function deliver(ctx: PluginContext): Promise<Response> {
	const request = new Request("http://test/checkout/webhook", {
		method: "POST",
		headers: { "verif-hash": "test-secret" },
		body: JSON.stringify({ split: true }),
	});
	const routeCtx = { ...ctx, request } as unknown as RouteContext;
	return (await sandbox.routes["checkout/webhook"].handler(routeCtx, ctx)) as Response;
}

describe("provider split settlement", () => {
	it("stores the provider's settlement on the order and maps account references to vendors", async () => {
		resetPaymentProviders();
		const base = createMockPaymentProvider({ id: "flw", capabilities: { splits: true } });
		registerPaymentProvider({
			...base,
			webhookHeaders: ["verif-hash"],
			parseWebhookEvent: () => splitEvent(),
			async getPaymentStatus() {
				return {
					status: "succeeded",
					paymentReference: "pay_split_1",
					amount: 150_000,
					currency: "KES",
				};
			},
		});
		const { ctx, getCol } = ctxWith({
			"settings:paymentProvider": "flw",
			"settings:flwSecretKey": "test-key",
			"settings:flwWebhookSecret": "test-secret",
		});

		const res = await deliver(ctx);
		expect(res.status).toBe(200);

		const orders = getCol("orders");
		expect(orders.size).toBe(1);
		const order = Array.from(orders.values())[0] as Order;
		expect(order.providerSplits).toMatchObject({
			providerId: "flw",
			allocations: [
				{ vendorId: "v1", accountReference: "RS_V1", amount: { amount: 90_000, currency: "KES" } },
				{ vendorId: "v2", accountReference: "RS_V2", amount: { amount: 45_000, currency: "KES" } },
			],
			platformRemainder: { amount: 7_650, currency: "KES" },
			providerFee: { amount: 7_350, currency: "KES" },
		});
		expect(order.providerSplits?.capturedAt).toBeTruthy();
	});

	it("keeps the order even when no settlement is reported", async () => {
		resetPaymentProviders();
		const base = createMockPaymentProvider({ id: "flw", capabilities: { splits: true } });
		registerPaymentProvider({
			...base,
			webhookHeaders: ["verif-hash"],
			parseWebhookEvent: () => ({ ...splitEvent(), splitSettlement: undefined }),
		});
		const { ctx, getCol } = ctxWith({
			"settings:paymentProvider": "flw",
			"settings:flwSecretKey": "test-key",
			"settings:flwWebhookSecret": "test-secret",
		});

		const res = await deliver(ctx);
		expect(res.status).toBe(200);
		const order = Array.from(getCol("orders").values())[0] as Order;
		expect(order.providerSplits).toBeUndefined();
	});
});

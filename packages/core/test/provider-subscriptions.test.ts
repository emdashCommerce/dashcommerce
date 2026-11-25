/**
 * Provider-managed subscriptions: the first charge creates an order and a
 * local subscription; later charges are invoices, not orders. Flutterwave
 * uses one payment plan per subscription, so the plan id is the local key.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	type NormalizedPaymentEvent,
	type PaymentProvider,
	type ProviderSubscriptionInfo,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import { cancel, pause, resume } from "../src/subscriptions/lifecycle";
import {
	addSubscriptionInterval,
	findProviderSubscription,
	recordProviderSubscriptionInvoice,
	upsertProviderSubscription,
} from "../src/subscriptions/provider";
import type { CartState, Order, Subscription, SubscriptionInvoice } from "../src/types";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const DRAFT_ID = "0123456789abcdef0123456789abcdef";
const RENEWAL_DRAFT_ID = "fedcba9876543210fedcba9876543210";

function subscriptionCart(sessionId: string): CartState {
	const cart = ticketCart(sessionId);
	cart.items = cart.items.map((item) => ({
		...item,
		subscriptionConfig: { interval: "month", intervalCount: 1 },
	}));
	return cart;
}

function provider(current: { paymentReference: string; subscription: ProviderSubscriptionInfo }) {
	const base = createMockPaymentProvider({ id: "acme" });
	const impl: PaymentProvider = {
		...base,
		webhookHeaders: ["x-acme-signature"],
		parseWebhookEvent(raw): NormalizedPaymentEvent {
			const body = JSON.parse(raw) as {
				id: string;
				orderDraftId: string;
				paymentReference: string;
			};
			return {
				type: "charge.succeeded",
				orderDraftId: body.orderDraftId,
				providerId: "acme",
				providerEventId: body.id,
				paymentReference: body.paymentReference,
				amount: 150_000,
				currency: "KES",
				customer: { email: "supporter@example.com" },
				subscription: current.subscription,
				raw: body,
			};
		},
		async getPaymentStatus() {
			return {
				status: "succeeded",
				paymentReference: current.paymentReference,
				amount: 150_000,
				currency: "KES",
				subscription: current.subscription,
			};
		},
	};
	return impl;
}

async function deliver(ctx: PluginContext, payload: string): Promise<Response> {
	const request = new Request("http://test/checkout/webhook", {
		method: "POST",
		headers: { "x-acme-signature": "signed" },
		body: payload,
	});
	const routeCtx = { ...ctx, request } as unknown as RouteContext;
	return (await sandbox.routes["checkout/webhook"].handler(routeCtx, ctx)) as Response;
}

function setup(current: { paymentReference: string; subscription: ProviderSubscriptionInfo }) {
	registerPaymentProvider(provider(current));
	const harness = makeRouteContext({
		"settings:paymentProvider": "acme",
		"settings:acmeSecretKey": "acme-key",
		"settings:acmeWebhookSecret": "test-secret",
	});
	harness.ctx.kv.set(`draft:${DRAFT_ID}`, {
		cart: subscriptionCart("sess_sub"),
		ttlMs: 900_000,
		createdAt: new Date().toISOString(),
	});
	return harness;
}

describe("addSubscriptionInterval", () => {
	it("clamps a month-end start to the last day of the next month", () => {
		expect(addSubscriptionInterval("2026-01-31T00:00:00.000Z", "month", 1)).toBe(
			"2026-02-28T00:00:00.000Z",
		);
	});

	it("adds weeks and years", () => {
		expect(addSubscriptionInterval("2026-01-01T00:00:00.000Z", "week", 2)).toBe(
			"2026-01-15T00:00:00.000Z",
		);
		expect(addSubscriptionInterval("2026-01-01T00:00:00.000Z", "year", 1)).toBe(
			"2027-01-01T00:00:00.000Z",
		);
	});
});

describe("provider-managed subscriptions", () => {
	it("creates an order and a local subscription from the first charge", async () => {
		const current = {
			paymentReference: "pay_sub_1",
			subscription: {
				providerSubscriptionId: "plan_1",
				status: "active" as const,
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			},
		};
		const { ctx, getCol } = setup(current);

		const res = await deliver(
			ctx,
			JSON.stringify({
				id: "evt_sub_1",
				orderDraftId: DRAFT_ID,
				paymentReference: "pay_sub_1",
			}),
		);
		expect(res.status).toBe(200);

		const order = Array.from(getCol("orders").values())[0] as Order;
		expect(order.subscriptionIds?.length).toBe(1);
		const sub = Array.from(getCol("subscriptions").values())[0] as Subscription;
		expect(sub).toMatchObject({
			stripeSubscriptionId: "acme:plan_1",
			providerId: "acme",
			providerSubscriptionId: "plan_1",
			customerId: order.customerId,
			status: "active",
			currency: "KES",
			interval: "month",
			intervalCount: 1,
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		});
		expect(sub.unitAmount).toEqual({ amount: 150_000, currency: "KES" });
		expect(getCol("subscription_invoices").size).toBe(0);
	});

	it("records a later charge as an invoice and does not create a second order", async () => {
		const current = {
			paymentReference: "pay_sub_1",
			subscription: {
				providerSubscriptionId: "plan_1",
				status: "active" as const,
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			},
		};
		const { ctx, getCol } = setup(current);

		await deliver(
			ctx,
			JSON.stringify({
				id: "evt_sub_1",
				orderDraftId: DRAFT_ID,
				paymentReference: "pay_sub_1",
			}),
		);
		expect(getCol("orders").size).toBe(1);

		current.paymentReference = "pay_sub_2";
		const res = await deliver(
			ctx,
			JSON.stringify({
				id: "evt_sub_2",
				orderDraftId: RENEWAL_DRAFT_ID,
				paymentReference: "pay_sub_2",
			}),
		);
		expect(res.status).toBe(200);
		expect(getCol("orders").size).toBe(1);

		const sub = Array.from(getCol("subscriptions").values())[0] as Subscription;
		expect(sub.currentPeriodStart).toBe("2026-02-01T00:00:00.000Z");
		expect(sub.currentPeriodEnd).toBe("2026-03-01T00:00:00.000Z");
		const invoice = Array.from(getCol("subscription_invoices").values())[0] as SubscriptionInvoice;
		expect(invoice).toMatchObject({
			stripeInvoiceId: "acme:pay_sub_2",
			providerId: "acme",
			providerInvoiceId: "pay_sub_2",
			subscriptionId: sub.id,
			status: "paid",
		});
		expect(invoice.amount).toEqual({ amount: 150_000, currency: "KES" });
	});

	it("does not extend the period twice for the same paid invoice", async () => {
		const { ctx } = makeRouteContext({});
		const sub = await upsertProviderSubscription(ctx, {
			providerId: "acme",
			providerSubscriptionId: "plan_dup",
			customerId: "cus_1",
			productId: "prod_1",
			status: "active",
			currency: "KES",
			unitAmount: 150_000,
			quantity: 1,
			interval: "month",
			intervalCount: 1,
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		});
		const first = await recordProviderSubscriptionInvoice(ctx, {
			subscription: sub,
			providerId: "acme",
			providerInvoiceId: "pay_dup",
			amount: 150_000,
			currency: "KES",
			status: "paid",
			periodStart: "2026-02-01T00:00:00.000Z",
		});
		const afterFirst = await findProviderSubscription(ctx, "acme", "plan_dup");
		expect(afterFirst?.currentPeriodEnd).toBe("2026-03-01T00:00:00.000Z");
		const second = await recordProviderSubscriptionInvoice(ctx, {
			subscription: afterFirst ?? sub,
			providerId: "acme",
			providerInvoiceId: "pay_dup",
			amount: 150_000,
			currency: "KES",
			status: "paid",
		});
		expect(second.id).toBe(first.id);
		const afterSecond = await findProviderSubscription(ctx, "acme", "plan_dup");
		expect(afterSecond?.currentPeriodEnd).toBe("2026-03-01T00:00:00.000Z");
	});

	it("applies a subscription.updated webhook to the local row", async () => {
		const base = createMockPaymentProvider({ id: "acme" });
		registerPaymentProvider({
			...base,
			webhookHeaders: ["x-acme-signature"],
			parseWebhookEvent(): NormalizedPaymentEvent {
				return {
					type: "subscription.updated",
					providerId: "acme",
					providerEventId: "sub-cancel-1",
					providerSubscriptionId: "plan_1",
					status: "canceled",
					canceledAt: "2026-02-01T00:00:00.000Z",
					raw: {},
				};
			},
		});
		const { ctx, getCol } = makeRouteContext({
			"settings:paymentProvider": "acme",
			"settings:acmeSecretKey": "acme-key",
			"settings:acmeWebhookSecret": "test-secret",
		});
		const sub = await upsertProviderSubscription(ctx, {
			providerId: "acme",
			providerSubscriptionId: "plan_1",
			customerId: "cus_1",
			productId: "prod_1",
			status: "active",
			currency: "KES",
			unitAmount: 150_000,
			quantity: 1,
			interval: "month",
			intervalCount: 1,
		});

		const res = await deliver(ctx, JSON.stringify({ cancel: true }));
		expect(res.status).toBe(200);
		const stored = getCol("subscriptions").get(sub.id) as Subscription;
		expect(stored.status).toBe("canceled");
		expect(stored.canceledAt).toBe("2026-02-01T00:00:00.000Z");
	});

	it("does not hand a provider's plan id to another provider", async () => {
		const current = {
			paymentReference: "pay_sub_1",
			subscription: {
				providerSubscriptionId: "plan_1",
				status: "active" as const,
			},
		};
		const { ctx, getCol } = setup(current);
		await deliver(
			ctx,
			JSON.stringify({
				id: "evt_sub_1",
				orderDraftId: DRAFT_ID,
				paymentReference: "pay_sub_1",
			}),
		);
		expect(await findProviderSubscription(ctx, "acme", "plan_1")).not.toBeNull();
		expect(await findProviderSubscription(ctx, "other", "plan_1")).toBeNull();
		expect(getCol("subscriptions").size).toBe(1);
	});
});

describe("provider-managed lifecycle", () => {
	it("cancels and resumes through the provider, not Stripe", async () => {
		const calls: Array<{ action: string; id: string }> = [];
		const base = createMockPaymentProvider({ id: "acme" });
		registerPaymentProvider({
			...base,
			async cancelSubscription(_ctx, input) {
				calls.push({ action: "cancel", id: input.providerSubscriptionId });
				return {
					providerSubscriptionId: input.providerSubscriptionId,
					status: "canceled" as const,
					canceledAt: "2026-02-01T00:00:00.000Z",
				};
			},
			async resumeSubscription(_ctx, input) {
				calls.push({ action: "resume", id: input.providerSubscriptionId });
				return {
					providerSubscriptionId: input.providerSubscriptionId,
					status: "active" as const,
				};
			},
		});
		const { ctx, getCol } = makeRouteContext({
			"settings:paymentProvider": "acme",
			"settings:acmeSecretKey": "acme-key",
		});
		const sub = await upsertProviderSubscription(ctx, {
			providerId: "acme",
			providerSubscriptionId: "plan_1",
			customerId: "cus_1",
			productId: "prod_1",
			status: "active",
			currency: "KES",
			unitAmount: 150_000,
			quantity: 1,
			interval: "month",
			intervalCount: 1,
		});

		const canceled = await cancel(ctx, { subscriptionId: sub.id, mode: "immediate" });
		expect(canceled.status).toBe("canceled");
		expect(calls).toEqual([{ action: "cancel", id: "plan_1" }]);
		expect((getCol("subscriptions").get(sub.id) as Subscription).status).toBe("canceled");

		const resumed = await resume(ctx, { subscriptionId: sub.id });
		expect(resumed.status).toBe("active");
		expect(calls).toEqual([
			{ action: "cancel", id: "plan_1" },
			{ action: "resume", id: "plan_1" },
		]);
		expect((getCol("subscriptions").get(sub.id) as Subscription).status).toBe("active");
	});

	it("refuses to pause a provider-managed subscription", async () => {
		const base = createMockPaymentProvider({ id: "acme" });
		registerPaymentProvider(base);
		const { ctx } = makeRouteContext({
			"settings:paymentProvider": "acme",
			"settings:acmeSecretKey": "acme-key",
		});
		const sub = await upsertProviderSubscription(ctx, {
			providerId: "acme",
			providerSubscriptionId: "plan_1",
			customerId: "cus_1",
			productId: "prod_1",
			status: "active",
			currency: "KES",
			unitAmount: 150_000,
			quantity: 1,
			interval: "month",
			intervalCount: 1,
		});
		await expect(pause(ctx, { subscriptionId: sub.id })).rejects.toThrow(
			/does not support pausing/i,
		);
	});
});

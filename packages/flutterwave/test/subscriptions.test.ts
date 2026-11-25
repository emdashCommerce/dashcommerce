import { describe, expect, it } from "bun:test";
import type {
	InitCheckoutInput,
	PaymentProviderRuntimeContext,
} from "@dashcommerce/core/payment-provider";
import { flutterwavePaymentProvider, parsePlanInterval, planInterval } from "../src/provider";

const credentials = { secretKey: "FLWSECK_TEST-1234567890abcdef-X" };
const publicCredentials = { ...credentials, publicKey: "FLWPUBK_TEST-1234567890abcdef-X" };

function ctx(handler: (url: string, init?: RequestInit) => Promise<Response>) {
	return {
		http: { fetch: handler },
		log: { info() {}, warn() {}, error() {} },
	} satisfies PaymentProviderRuntimeContext;
}

function ok(data: unknown): Response {
	return new Response(JSON.stringify({ status: "success", message: "ok", data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function subscriptionInput(overrides: Partial<InitCheckoutInput> = {}): InitCheckoutInput {
	return {
		orderDraftId: "0123456789abcdef0123456789abcdef",
		amount: 250_000,
		currency: "KES",
		customer: { email: "fan@example.com" },
		lineItems: [
			{
				name: "Monthly magazine",
				amount: 250_000,
				currency: "KES",
				quantity: 1,
				recurring: { interval: "month", intervalCount: 1 },
			},
		],
		successUrl: "https://shop.example/thank-you",
		cancelUrl: "https://shop.example/checkout",
		mode: "subscription",
		subscriptionMetadata: { dashcommerceProductId: "prod_1" },
		...overrides,
	};
}

describe("Flutterwave subscription intervals", () => {
	it("maps core intervals to Flutterwave's plan syntax", () => {
		expect(planInterval("day", 1)).toBe("daily");
		expect(planInterval("week", 1)).toBe("weekly");
		expect(planInterval("month", 1)).toBe("monthly");
		expect(planInterval("year", 1)).toBe("yearly");
		expect(planInterval("month", 3)).toBe("every 3 months");
		expect(planInterval("day", 90)).toBe("every 90 days");
	});

	it("parses Flutterwave's plan intervals", () => {
		expect(parsePlanInterval("monthly")).toEqual({ interval: "month", intervalCount: 1 });
		expect(parsePlanInterval("quarterly")).toEqual({ interval: "month", intervalCount: 3 });
		expect(parsePlanInterval("every 2 weeks")).toEqual({ interval: "week", intervalCount: 2 });
		expect(parsePlanInterval("yearly")).toEqual({ interval: "year", intervalCount: 1 });
		expect(parsePlanInterval(undefined)).toEqual({ interval: "month", intervalCount: 1 });
	});
});

describe("Flutterwave subscription checkout", () => {
	it("creates one payment plan and passes its id to hosted checkout", async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
		const runtime = ctx(async (url, init) => {
			const { pathname } = new URL(url);
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
			calls.push({ path: pathname, body });
			if (pathname === "/v3/payment-plans") {
				return ok({
					id: 254811,
					name: body.name,
					amount: body.amount,
					currency: body.currency,
					interval: body.interval,
				});
			}
			if (pathname === "/v3/payments") {
				return ok({ link: "https://checkout.flutterwave.com/v3/hosted/pay/abc" });
			}
			return new Response("{}", { status: 404 });
		});

		const result = await flutterwavePaymentProvider.initCheckout(
			runtime,
			subscriptionInput({
				amount: 260_000,
				lineItems: [
					...subscriptionInput().lineItems,
					{ name: "Tax", amount: 10_000, currency: "KES", quantity: 1 },
				],
			}),
			credentials,
		);

		expect(result.kind).toBe("redirect");
		expect(calls[0]?.path).toBe("/v3/payment-plans");
		expect(calls[0]?.body).toMatchObject({
			amount: 2500,
			currency: "KES",
			interval: "monthly",
			duration: 0,
		});
		expect(calls[1]?.path).toBe("/v3/payments");
		expect(calls[1]?.body.amount).toBe(2600);
		expect(calls[1]?.body.payment_plan).toBe("254811");
		expect(calls[1]?.body.meta).toMatchObject({
			orderDraftId: "0123456789abcdef0123456789abcdef",
			dashcommerceProductId: "prod_1",
		});
	});

	it("passes the plan to Inline on the on-page path", async () => {
		const calls: string[] = [];
		const runtime = ctx(async (url) => {
			const { pathname } = new URL(url);
			calls.push(pathname);
			if (pathname === "/v3/payment-plans") return ok({ id: 254811, name: "DC plan" });
			return new Response("{}", { status: 404 });
		});

		const result = await flutterwavePaymentProvider.initCheckout(
			runtime,
			subscriptionInput({ checkoutStyle: "on_page" }),
			publicCredentials,
		);

		expect(result.kind).toBe("on_page");
		if (result.kind !== "on_page") throw new Error("expected on_page");
		expect(result.client.paymentPlan).toBe("254811");
		expect(calls).toEqual(["/v3/payment-plans"]);
	});

	it("refuses trials and multi-line subscription carts", async () => {
		const runtime = ctx(async () => ok({ id: 1 }));
		await expect(
			flutterwavePaymentProvider.initCheckout(
				runtime,
				subscriptionInput({ subscriptionTrialPeriodDays: 7 }),
				credentials,
			),
		).rejects.toThrow(/do not support trials/i);
		await expect(
			flutterwavePaymentProvider.initCheckout(
				runtime,
				subscriptionInput({
					lineItems: [
						...subscriptionInput().lineItems,
						{
							name: "Second",
							amount: 100,
							currency: "KES",
							quantity: 1,
							recurring: { interval: "month", intervalCount: 1 },
						},
					],
				}),
				credentials,
			),
		).rejects.toThrow(/one subscription line/i);
	});
});

describe("Flutterwave subscription state", () => {
	it("reports the plan id from a webhook", () => {
		const event = flutterwavePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				event: "charge.completed",
				data: {
					id: 10634465,
					tx_ref: "dc-0123456789abcdef0123456789abcdef",
					status: "successful",
					amount: 2500,
					currency: "KES",
					plan: 254811,
					customer: { email: "fan@example.com" },
				},
			}),
		);
		expect(event.type).toBe("charge.succeeded");
		if (event.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
		expect(event.subscription?.providerSubscriptionId).toBe("254811");
	});

	it("accepts a renewal with no order draft when it has a plan", () => {
		const event = flutterwavePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				event: "charge.completed",
				data: {
					id: 10634466,
					tx_ref: "renewal-10634466",
					status: "successful",
					amount: 2500,
					currency: "KES",
					plan: 254811,
					customer: { email: "fan@example.com" },
				},
			}),
		);
		expect(event.type).toBe("charge.succeeded");
		if (event.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
		expect(event.orderDraftId).toBe("");
		expect(event.subscription?.providerSubscriptionId).toBe("254811");
	});

	it("maps subscription.cancelled to a subscription update", () => {
		const event = flutterwavePaymentProvider.parseWebhookEvent(
			JSON.stringify({
				event: "subscription.cancelled",
				data: {
					status: "deactivated",
					plan: { id: 254811, status: "cancel" },
					customer: { email: "fan@example.com" },
				},
			}),
		);
		expect(event.type).toBe("subscription.updated");
		if (event.type !== "subscription.updated") throw new Error("expected subscription.updated");
		expect(event.providerSubscriptionId).toBe("254811");
		expect(event.status).toBe("canceled");
	});

	it("reports the plan id from a live verify", async () => {
		const runtime = ctx(async () =>
			ok({
				id: 10634465,
				status: "successful",
				amount: 2500,
				currency: "KES",
				plan: 254811,
			}),
		);
		const status = await flutterwavePaymentProvider.getPaymentStatus(
			runtime,
			"10634465",
			credentials,
		);
		expect(status.subscription?.providerSubscriptionId).toBe("254811");
		expect(status.subscription?.amount).toBe(250_000);
		expect(status.subscription?.currency).toBe("KES");
	});

	it("cancels and resumes through the payment plan", async () => {
		const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
		const runtime = ctx(async (url, init) => {
			const { pathname } = new URL(url);
			calls.push({
				method: init?.method ?? "GET",
				path: pathname,
				...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
			});
			if (init?.method === "PUT" && pathname.endsWith("/cancel")) {
				return ok({ id: 254811, status: "cancelled" });
			}
			if (init?.method === "GET") {
				return ok({
					id: 254811,
					name: "DC plan",
					amount: 2500,
					currency: "KES",
					interval: "monthly",
					status: "cancel",
				});
			}
			if (init?.method === "PUT") {
				return ok({ id: 254811, status: "active" });
			}
			return new Response("{}", { status: 404 });
		});

		const canceled = await flutterwavePaymentProvider.cancelSubscription?.(
			runtime,
			{ providerSubscriptionId: "254811" },
			credentials,
		);
		expect(canceled?.status).toBe("canceled");
		expect(calls[0]).toMatchObject({
			method: "PUT",
			path: "/v3/payment-plans/254811/cancel",
		});

		const resumed = await flutterwavePaymentProvider.resumeSubscription?.(
			runtime,
			{ providerSubscriptionId: "254811" },
			credentials,
		);
		expect(resumed?.status).toBe("active");
		expect(calls[1]).toMatchObject({ method: "GET", path: "/v3/payment-plans/254811" });
		expect(calls[2]).toMatchObject({
			method: "PUT",
			path: "/v3/payment-plans/254811",
			body: { name: "DC plan", status: "active" },
		});
	});
});

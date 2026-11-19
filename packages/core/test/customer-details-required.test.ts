/**
 * Stripe's hosted page collects the customer's email and address; other
 * providers' pages may not. For those, checkout must have them before it
 * starts a payment, or the paid order could never be created.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
	stripePaymentProvider,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const settings = {
	"settings:paymentProvider": "mock",
	"settings:checkoutMode": "hosted",
	"settings:mockSecretKey": "k",
	"settings:mockWebhookSecret": "test-secret",
};

async function createSession(cartOverrides: Record<string, unknown>) {
	const { ctx } = makeRouteContext(settings);
	const sessionId = `sess_${Math.random()}`;
	const cart = { ...ticketCart(sessionId), ...cartOverrides };
	await ctx.kv.set(`cart:${sessionId}`, cart);
	const routeCtx = {
		...ctx,
		request: new Request("http://test/checkout/create-session", {
			method: "POST",
			headers: { Cookie: `dashcommerce_sid=${sessionId}` },
		}),
		input: {},
	} as unknown as RouteContext;
	const res = (await sandbox.routes["checkout/create-session"].handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("customer details for providers that don't collect them", () => {
	it("Stripe declares that its hosted page collects them", () => {
		expect(stripePaymentProvider.collectsCustomerDetails).toBe(true);
	});

	it("refuses to start a payment without the customer's email", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const res = await createSession({ customerEmail: undefined });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("customer_details_required");
		expect(String(res.body.error)).toMatch(/email/i);
	});

	it("refuses without any address", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const res = await createSession({ billingAddress: undefined, shippingAddress: undefined });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("customer_details_required");
	});

	it("starts the payment once email and an address are on the cart", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const res = await createSession({ shippingAddress: undefined });
		expect(res.status).toBe(200);
		expect(res.body.orderDraftId).toBeTruthy();
	});

	it("does not ask when the provider collects the details itself", async () => {
		registerPaymentProvider(
			{ ...createMockPaymentProvider(), collectsCustomerDetails: true },
			{ override: true },
		);
		const res = await createSession({
			customerEmail: undefined,
			billingAddress: undefined,
			shippingAddress: undefined,
		});
		expect(res.status).toBe(200);
	});
});

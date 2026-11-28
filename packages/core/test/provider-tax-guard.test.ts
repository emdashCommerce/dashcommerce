/**
 * Stripe Tax is calculated by Stripe at checkout. Core returns zero tax for
 * that mode, so a provider that ignores automatic_tax would charge the
 * pre-tax total. Checkout must refuse instead of undercharging.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

async function createSession(settings: Record<string, unknown>) {
	const { ctx } = makeRouteContext({
		"settings:paymentProvider": "mock",
		"settings:checkoutMode": "hosted",
		"settings:mockSecretKey": "k",
		"settings:mockWebhookSecret": "test-secret",
		...settings,
	});
	const sessionId = `sess_${Math.random()}`;
	await ctx.kv.set(`cart:${sessionId}`, ticketCart(sessionId));
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

describe("Stripe Tax with a non-Stripe provider", () => {
	it("refuses stripe_tax instead of charging the pre-tax total", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const res = await createSession({ "settings:taxMode": "stripe_tax" });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("stripe_tax_requires_stripe");
		expect(String(res.body.error)).toMatch(/flat or table/i);
	});

	it("still starts checkout with flat tax", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const res = await createSession({ "settings:taxMode": "flat" });
		expect(res.status).toBe(200);
		expect(res.body.orderDraftId).toBeTruthy();
	});
});

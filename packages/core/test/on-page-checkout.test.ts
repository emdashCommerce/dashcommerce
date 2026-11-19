/**
 * FIK-59 slice 4: on-page checkout for providers other than Stripe.
 * `checkoutMode = "embedded"` means on-page with the active provider.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import { deliverWebhook, makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

function settings(mode: "hosted" | "embedded") {
	return {
		"settings:paymentProvider": "mock",
		"settings:checkoutMode": mode,
		"settings:mockSecretKey": "k",
		"settings:mockWebhookSecret": "test-secret",
	};
}

async function createSession(ctx: PluginContext) {
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

describe("on-page checkout", () => {
	it("returns the provider's on-page data and keeps the draft for the webhook", async () => {
		registerPaymentProvider(createMockPaymentProvider({ onPageCheckout: true }), {
			override: true,
		});
		const { ctx } = makeRouteContext(settings("embedded"));
		const { status, body } = await createSession(ctx);
		expect(status).toBe(200);
		expect(body.kind).toBe("on_page");
		expect(body.providerId).toBe("mock");
		expect(body.client).toEqual({ reference: `mock_ref_${body.orderDraftId}` });
		expect(body.url).toBeUndefined();
		expect(body.returnUrl).toBe(`https://shop.example/thank-you/${body.orderDraftId}`);
		const draft = await ctx.kv.get<{ providerId: string }>(`draft:${body.orderDraftId}`);
		expect(draft?.providerId).toBe("mock");
	});

	it("still redirects in hosted mode", async () => {
		registerPaymentProvider(createMockPaymentProvider({ onPageCheckout: true }), {
			override: true,
		});
		const { ctx } = makeRouteContext(settings("hosted"));
		const { status, body } = await createSession(ctx);
		expect(status).toBe(200);
		expect(typeof body.url).toBe("string");
		expect(body.kind).toBe("redirect");
	});

	it("refuses on-page for a provider that doesn't offer it, naming the provider", async () => {
		registerPaymentProvider(createMockPaymentProvider(), { override: true });
		const { ctx } = makeRouteContext(settings("embedded"));
		const { status, body } = await createSession(ctx);
		expect(status).toBe(409);
		expect(String(body.error)).toContain("Mock (mock)");
		expect(String(body.error)).toMatch(/hosted/);
	});

	it("creates the order only from the signed webhook, after on-page payment", async () => {
		registerPaymentProvider(createMockPaymentProvider({ onPageCheckout: true }), {
			override: true,
		});
		const { ctx, getCol } = makeRouteContext(settings("embedded"));
		const { body } = await createSession(ctx);
		expect(getCol("orders").size).toBe(0);

		const res = await deliverWebhook(
			ctx,
			JSON.stringify({
				id: "evt_onpage_1",
				type: "charge.succeeded",
				orderDraftId: body.orderDraftId,
				paymentReference: "pay_onpage_1",
				amount: 150000,
				currency: "KES",
			}),
			{ "x-mock-signature": "signed" },
		);
		expect(res.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});
});

/**
 * When a provider refuses the cart's currency (a Paystack account not
 * enabled for USD, say), create-session answers with a 400 the customer can
 * act on, not a 500 that suggests trying again.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { RouteContext } from "emdash";
import {
	CurrencyNotSupportedError,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const mockSettings = {
	"settings:paymentProvider": "mock",
	"settings:checkoutMode": "hosted",
	"settings:mockSecretKey": "mock-secret-key",
	"settings:mockWebhookSecret": "test-secret",
};

function providerThrowing(err: Error) {
	return {
		...createMockPaymentProvider({ id: "mock" }),
		async initCheckout(): Promise<never> {
			throw err;
		},
	};
}

async function createSession(ctx: import("emdash").PluginContext, sessionId: string) {
	await ctx.kv.set(`cart:${sessionId}`, ticketCart(sessionId));
	const routeCtx = {
		...ctx,
		request: new Request("http://test/checkout/create-session", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: `dashcommerce_sid=${sessionId}` },
		}),
		input: { customerEmail: "supporter@example.com" },
	} as unknown as RouteContext;
	return (await sandbox.routes["checkout/create-session"].handler(routeCtx, ctx)) as Response;
}

describe("create-session when the provider refuses the currency", () => {
	it("answers 400 with a message naming the currency", async () => {
		registerPaymentProvider(providerThrowing(new CurrencyNotSupportedError("KES")), {
			override: true,
		});
		const { ctx, logs } = makeRouteContext(mockSettings);
		const res = await createSession(ctx, "sess_currency_refused");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error:
				"This shop can't take payments in KES right now. Choose another currency, or contact the shop.",
			code: "currency_not_supported",
			currency: "KES",
		});
		expect(logs).toContainEqual(
			expect.objectContaining({
				level: "warn",
				meta: { providerId: "mock", currency: "KES" },
			}),
		);
	});

	it("recognises the error by its code, so a provider bundling its own copy of core works", async () => {
		const foreign = Object.assign(new Error("refused"), {
			code: "currency_not_supported",
			currency: "USD",
		});
		registerPaymentProvider(providerThrowing(foreign), { override: true });
		const { ctx } = makeRouteContext(mockSettings);
		const res = await createSession(ctx, "sess_currency_foreign");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { currency?: string }).currency).toBe("USD");
	});

	it("still fails loudly for any other provider error", async () => {
		registerPaymentProvider(providerThrowing(new Error("Paystack is down")), { override: true });
		const { ctx } = makeRouteContext(mockSettings);
		await expect(createSession(ctx, "sess_other_error")).rejects.toThrow("Paystack is down");
	});
});

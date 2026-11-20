import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { configCheckRoutes } from "../src/routes/config-check";
import { makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

async function check(ctx: PluginContext) {
	const res = (await configCheckRoutes["config-check"].handler(
		{ request: new Request("http://test/config-check") } as unknown as RouteContext,
		ctx,
	)) as Response;
	return (await res.json()) as Record<string, unknown>;
}

describe("config-check names the active provider", () => {
	it("keeps the Stripe fields and reports Stripe by default", async () => {
		const { ctx } = makeRouteContext({ "settings:stripeSecretKey": "sk_test_1234567890abcdef" });
		const body = await check(ctx);
		expect(body.stripeSecretConfigured).toBe(true);
		expect(body.stripeWebhookConfigured).toBe(false);
		expect(body.paymentProvider).toEqual({
			id: "stripe",
			label: "Stripe",
			configured: false,
			checkoutMode: "hosted",
		});
	});

	it("reports another provider as configured from its own keys, without Stripe's", async () => {
		registerPaymentProvider({ ...createMockPaymentProvider({ id: "acme" }), label: "Acme Pay" });
		const { ctx } = makeRouteContext({
			"settings:paymentProvider": "acme",
			"settings:checkoutMode": "embedded",
			"settings:acmeSecretKey": "ak_1",
			"settings:acmeWebhookSecret": "aw_1",
		});
		const body = await check(ctx);
		expect(body.stripeSecretConfigured).toBe(false);
		expect(body.paymentProvider).toEqual({
			id: "acme",
			label: "Acme Pay",
			configured: true,
			checkoutMode: "embedded",
		});
	});

	it("says when the configured provider is not registered", async () => {
		const { ctx } = makeRouteContext({ "settings:paymentProvider": "ghost" });
		const body = await check(ctx);
		expect(body.paymentProvider).toMatchObject({
			id: "ghost",
			configured: false,
			registered: false,
		});
	});
});

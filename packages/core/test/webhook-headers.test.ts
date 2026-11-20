/**
 * Providers whose signature scheme uses headers other than
 * `x-<id>-signature` (Paystack's `Paystack-Signature`, Standard Webhooks'
 * `webhook-id` / `webhook-timestamp` / `webhook-signature`) can declare
 * them, and `verifyWebhook` receives every request header.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	createMockPaymentProvider,
	type PaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
	resolveWebhookProvider,
	type VerifyWebhookInput,
} from "../src/payment-provider";
import { deliverWebhook, makeRouteContext, startCheckout } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const emptyKv = { get: async () => null };

function acme(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
	return {
		...createMockPaymentProvider({ id: "acme" }),
		webhookHeaders: ["acme-signature", "webhook-signature"],
		...overrides,
	};
}

describe("resolveWebhookProvider with declared webhook headers", () => {
	it("routes a request carrying only a declared header to that provider", async () => {
		registerPaymentProvider(acme());
		const { provider, signatureHeader } = await resolveWebhookProvider(
			emptyKv,
			new Headers({ "Acme-Signature": "t=1,v1=abc" }),
		);
		expect(provider.id).toBe("acme");
		expect(signatureHeader).toBe("t=1,v1=abc");
	});

	it("prefers the declared headers, in order, over x-<id>-signature", async () => {
		registerPaymentProvider(acme());
		const { signatureHeader } = await resolveWebhookProvider(
			emptyKv,
			new Headers({ "x-acme-signature": "legacy", "acme-signature": "current" }),
		);
		expect(signatureHeader).toBe("current");
	});

	it("still routes x-<id>-signature when nothing declared is present", async () => {
		registerPaymentProvider(acme());
		const { provider, signatureHeader } = await resolveWebhookProvider(
			emptyKv,
			new Headers({ "x-acme-signature": "legacy" }),
		);
		expect(provider.id).toBe("acme");
		expect(signatureHeader).toBe("legacy");
	});

	it("keeps stripe-signature routing first", async () => {
		registerPaymentProvider(acme());
		const { provider } = await resolveWebhookProvider(
			emptyKv,
			new Headers({ "stripe-signature": "t=1,v1=x", "acme-signature": "y" }),
		);
		expect(provider.id).toBe("stripe");
	});

	it("uses declared headers with ?provider= and with the configured provider", async () => {
		registerPaymentProvider(acme());
		const viaQuery = await resolveWebhookProvider(
			emptyKv,
			new Headers({ "webhook-signature": "v1,abc" }),
			"https://shop.example/checkout/webhook?provider=acme",
		);
		expect(viaQuery.signatureHeader).toBe("v1,abc");

		const configured = await resolveWebhookProvider(
			{ get: async <T>() => "acme" as T },
			new Headers({ "webhook-signature": "v1,def" }),
		);
		expect(configured.provider.id).toBe("acme");
		expect(configured.signatureHeader).toBe("v1,def");
	});

	it("refuses a provider that declares Stripe's header", () => {
		expect(() => registerPaymentProvider(acme({ webhookHeaders: ["Stripe-Signature"] }))).toThrow(
			/stripe-signature/i,
		);
	});
});

describe("webhook route passes every header to verifyWebhook", () => {
	it("hands the provider the full request headers", async () => {
		let seen: VerifyWebhookInput | undefined;
		const base = acme();
		registerPaymentProvider({
			...base,
			async verifyWebhook(input) {
				seen = input;
				return base.verifyWebhook(input);
			},
		});
		const { ctx } = makeRouteContext({
			"settings:paymentProvider": "acme",
			"settings:checkoutMode": "hosted",
			"settings:acmeSecretKey": "acme-key",
			"settings:acmeWebhookSecret": "test-secret",
		});
		const draftId = await startCheckout(ctx, "sess_headers");

		const res = await deliverWebhook(
			ctx,
			JSON.stringify({
				id: "evt_h1",
				type: "charge.succeeded",
				orderDraftId: draftId,
				paymentReference: "pay_h1",
				amount: 150000,
				currency: "KES",
			}),
			{
				"webhook-id": "msg_1",
				"webhook-timestamp": "1760270400",
				"webhook-signature": "v1,abc",
			},
		);

		expect(res.status).toBe(200);
		expect(seen?.signatureHeader).toBe("v1,abc");
		expect(seen?.headers?.get("webhook-id")).toBe("msg_1");
		expect(seen?.headers?.get("webhook-timestamp")).toBe("1760270400");
		// Some providers sign a header with the API key rather than the
		// webhook secret (Paystack's x-paystack-signature), so the provider
		// gets both of its saved credentials.
		expect(seen?.secret).toBe("test-secret");
		expect(seen?.credentials).toEqual({ secretKey: "acme-key", webhookSecret: "test-secret" });
	});
});

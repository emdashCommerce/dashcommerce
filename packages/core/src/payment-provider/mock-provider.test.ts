// mock-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockPaymentProvider } from "./mock-provider";
import type { PaymentProviderCredentials, PaymentProviderRuntimeContext } from "./types";

const ctx: PaymentProviderRuntimeContext = {
	http: { fetch },
	log: { info: () => {}, warn: () => {}, error: () => {} },
};

const creds: PaymentProviderCredentials = { secretKey: "sk_test_mock" };

test("mock: initCheckout succeeds by default and echoes orderDraftId into the reference", async () => {
	const provider = createMockPaymentProvider();
	const result = await provider.initCheckout(
		ctx,
		{
			orderDraftId: "d1",
			amount: 1000,
			currency: "KES",
			customer: { email: "x@example.com" },
			lineItems: [{ name: "Jersey", amount: 1000, currency: "KES", quantity: 1 }],
			successUrl: "https://example.com/thank-you",
			cancelUrl: "https://example.com/checkout",
		},
		creds,
	);
	assert.equal(result.providerReference, "mock_ref_d1");
	assert.match(result.redirectUrl, /mock=1$/);
});

test("mock: initCheckout can be forced to fail for negative-path tests", async () => {
	const provider = createMockPaymentProvider({ failInit: true });
	await assert.rejects(() =>
		provider.initCheckout(
			ctx,
			{
				orderDraftId: "d2",
				amount: 1000,
				currency: "KES",
				customer: { email: "x@example.com" },
				lineItems: [],
				successUrl: "https://example.com/thank-you",
				cancelUrl: "https://example.com/checkout",
			},
			creds,
		),
	);
});

test("mock: verifyWebhook only accepts the fixture 'test-secret'", async () => {
	const provider = createMockPaymentProvider();
	const ok = await provider.verifyWebhook({
		rawBody: "{}",
		signatureHeader: "x",
		secret: "test-secret",
	});
	assert.equal(ok.ok, true);
	const bad = await provider.verifyWebhook({
		rawBody: "{}",
		signatureHeader: "x",
		secret: "wrong",
	});
	assert.equal(bad.ok, false);
});

test("mock: parseWebhookEvent round-trips charge.succeeded", () => {
	const provider = createMockPaymentProvider();
	const event = provider.parseWebhookEvent(
		JSON.stringify({
			type: "charge.succeeded",
			orderDraftId: "d3",
			providerReference: "ref3",
			amount: 500,
			currency: "KES",
			email: "y@example.com",
		}),
	);
	assert.equal(event.type, "charge.succeeded");
	if (event.type === "charge.succeeded") {
		assert.equal(event.orderDraftId, "d3");
		assert.equal(event.amount, 500);
	}
});

test("mock: refund succeeds by default, can be forced to fail", async () => {
	const provider = createMockPaymentProvider();
	const refund = await provider.refund(ctx, { providerReference: "ref3", currency: "KES" }, creds);
	assert.equal(refund.status, "succeeded");

	const failing = createMockPaymentProvider({ failRefund: true });
	await assert.rejects(() =>
		failing.refund(ctx, { providerReference: "ref3", currency: "KES" }, creds),
	);
});

test("mock: formatAmount", () => {
	const provider = createMockPaymentProvider();
	assert.equal(provider.formatAmount({ amount: 250000, currency: "KES" }), "KES 2500.00");
});

/**
 * What a provider declares for on-page checkout.
 */

import { describe, expect, it } from "bun:test";
import {
	createMockPaymentProvider,
	type PaymentProviderRuntimeContext,
	providerCheckoutStyles,
	stripePaymentProvider,
} from "../src/payment-provider";

function ctxWith(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
	return {
		http: { fetch },
		log: { info() {}, warn() {}, error() {} },
	} as PaymentProviderRuntimeContext;
}

describe("checkout styles", () => {
	it("defaults to hosted only when a provider declares nothing", () => {
		expect(providerCheckoutStyles(createMockPaymentProvider())).toEqual(["hosted"]);
	});

	it("Stripe offers hosted and on-page (Elements)", () => {
		expect(providerCheckoutStyles(stripePaymentProvider)).toEqual(["hosted", "on_page"]);
	});

	it("the mock provider can declare on-page and returns an on_page result", async () => {
		const mock = createMockPaymentProvider({ onPageCheckout: true });
		expect(providerCheckoutStyles(mock)).toEqual(["hosted", "on_page"]);
		const result = await mock.initCheckout(
			ctxWith(async () => new Response()),
			{
				orderDraftId: "d1",
				amount: 100,
				currency: "KES",
				customer: { email: "a@example.com" },
				lineItems: [],
				successUrl: "https://shop.example/thank-you/d1",
				cancelUrl: "https://shop.example/checkout",
				checkoutStyle: "on_page",
			},
			{ secretKey: "x" },
		);
		expect(result).toEqual({
			kind: "on_page",
			checkoutReference: "mock_ref_d1",
			client: { reference: "mock_ref_d1" },
		});
	});
});

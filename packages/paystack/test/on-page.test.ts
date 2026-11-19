/**
 * Paystack on-page checkout: the Popup, opened over the store's
 * checkout with the access code from /transaction/initialize.
 */

import { describe, expect, it } from "bun:test";
import type { PaymentProviderRuntimeContext } from "@dashcommerce/core/payment-provider";
import {
	createPaystackCheckoutClient,
	PAYSTACK_INLINE_SCRIPT,
	registerPaystackCheckoutClient,
} from "../src/checkout-client";
import { paystackPaymentProvider } from "../src/provider";

describe("provider declarations", () => {
	it("offers hosted and on-page checkout, and needs the store to collect customer details", () => {
		expect(paystackPaymentProvider.checkoutStyles).toEqual(["hosted", "on_page"]);
		expect(paystackPaymentProvider.collectsCustomerDetails).toBeFalsy();
		expect(paystackPaymentProvider.description).toMatch(/M-Pesa/);
	});

	it("returns the access code for on-page checkout", async () => {
		const ctx: PaymentProviderRuntimeContext = {
			http: {
				fetch: async () =>
					new Response(
						JSON.stringify({
							status: true,
							message: "Authorization URL created",
							data: {
								authorization_url: "https://checkout.paystack.com/abc",
								access_code: "abc123access",
								reference: "dc-0123456789abcdef0123456789abcdef",
							},
						}),
					),
			},
			log: { info() {}, warn() {}, error() {} },
		};
		const result = await paystackPaymentProvider.initCheckout(
			ctx,
			{
				orderDraftId: "0123456789abcdef0123456789abcdef",
				amount: 150000,
				currency: "KES",
				customer: { email: "fan@example.com" },
				lineItems: [],
				successUrl: "https://shop.example/thank-you/x",
				cancelUrl: "https://shop.example/checkout",
				checkoutStyle: "on_page",
			},
			{ secretKey: "sk_test_1234567890abcdef" },
		);
		expect(result).toEqual({
			kind: "on_page",
			checkoutReference: "dc-0123456789abcdef0123456789abcdef",
			client: { accessCode: "abc123access" },
		});
	});
});

/** A minimal browser stand-in: script tags "load" when the test says so. */
function fakeBrowser() {
	const appended: Array<{ src: string; onload?: () => void; onerror?: () => void }> = [];
	const resumed: Array<{ code: string; callbacks: Record<string, (arg?: unknown) => void> }> = [];
	const win: Record<string, unknown> = {};
	class PaystackPop {
		resumeTransaction(code: string, callbacks: Record<string, (arg?: unknown) => void>) {
			resumed.push({ code, callbacks });
		}
	}
	const doc = {
		createElement: () =>
			({}) as { src: string; async?: boolean; onload?: () => void; onerror?: () => void },
		head: {
			appendChild: (el: { src: string; onload?: () => void; onerror?: () => void }) => {
				appended.push(el);
			},
		},
	};
	return {
		win,
		doc,
		appended,
		resumed,
		loadScript() {
			win.PaystackPop = PaystackPop;
			for (const el of appended) el.onload?.();
		},
		failScript() {
			for (const el of appended) el.onerror?.();
		},
	};
}

function recorder() {
	const events: string[] = [];
	return {
		events,
		callbacks: {
			onFinished: () => events.push("finished"),
			onClosed: () => events.push("closed"),
			onError: (m: string) => events.push(`error:${m}`),
		},
	};
}

describe("Paystack checkout client", () => {
	it("loads inline.js only when opened, then resumes the transaction", async () => {
		const b = fakeBrowser();
		const client = createPaystackCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		expect(b.appended).toHaveLength(0);

		const r = recorder();
		client.open({ accessCode: "abc123access" }, r.callbacks);
		expect(b.appended.map((s) => s.src)).toEqual([PAYSTACK_INLINE_SCRIPT]);
		b.loadScript();
		await Promise.resolve();
		await Promise.resolve();
		expect(b.resumed.map((x) => x.code)).toEqual(["abc123access"]);

		b.resumed[0]?.callbacks.onSuccess?.({ reference: "dc-x" });
		expect(r.events).toEqual(["finished"]);
	});

	it("reuses the loaded script for a second attempt", async () => {
		const b = fakeBrowser();
		const client = createPaystackCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open({ accessCode: "first" }, r.callbacks);
		b.loadScript();
		await Promise.resolve();
		await Promise.resolve();
		b.resumed[0]?.callbacks.onCancel?.();
		client.open({ accessCode: "second" }, r.callbacks);
		await Promise.resolve();
		await Promise.resolve();
		expect(b.appended).toHaveLength(1);
		expect(b.resumed.map((x) => x.code)).toEqual(["first", "second"]);
		expect(r.events).toEqual(["closed"]);
	});

	it("reports Paystack's load error", async () => {
		const b = fakeBrowser();
		const client = createPaystackCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open({ accessCode: "abc" }, r.callbacks);
		b.loadScript();
		await Promise.resolve();
		await Promise.resolve();
		b.resumed[0]?.callbacks.onError?.({ message: "Transaction not found" });
		expect(r.events).toEqual(["error:Transaction not found"]);
	});

	it("says so when the script can't load, and lets the customer retry", async () => {
		const b = fakeBrowser();
		const client = createPaystackCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open({ accessCode: "abc" }, r.callbacks);
		b.failScript();
		await Promise.resolve();
		await Promise.resolve();
		expect(r.events[0]).toMatch(/^error:Could not load Paystack/);

		client.open({ accessCode: "abc" }, r.callbacks);
		expect(b.appended).toHaveLength(2);
	});

	it("refuses to open without an access code", () => {
		const b = fakeBrowser();
		const client = createPaystackCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open({}, r.callbacks);
		expect(r.events).toEqual(["error:Paystack did not return an access code"]);
		expect(b.appended).toHaveLength(0);
	});

	it("registers itself next to other providers' clients", () => {
		const b = fakeBrowser();
		const other = { open() {} };
		b.win.DashCommerceCheckoutClients = { acme: other };
		registerPaystackCheckoutClient(b.win as unknown as Window, b.doc as unknown as Document);
		const clients = b.win.DashCommerceCheckoutClients as Record<string, unknown>;
		expect(clients.acme).toBe(other);
		expect(typeof (clients.paystack as { open: unknown }).open).toBe("function");
	});
});

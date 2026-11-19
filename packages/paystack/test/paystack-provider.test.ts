import { describe, expect, it } from "bun:test";
import type {
	InitCheckoutInput,
	PaymentProviderRuntimeContext,
} from "@dashcommerce/core/payment-provider";
import { paystackPaymentProvider, paystackReferenceFor } from "../src/provider";

function makeMockRuntimeContext(
	fetchHandler: (url: string, init?: RequestInit) => Promise<Response>,
): PaymentProviderRuntimeContext {
	return {
		http: { fetch: fetchHandler },
		log: { info() {}, warn() {}, error() {} },
	};
}

function checkoutInput(overrides: Partial<InitCheckoutInput> = {}): InitCheckoutInput {
	return {
		orderDraftId: "0123456789abcdef0123456789abcdef",
		amount: 250000, // KES 2,500.00
		currency: "KES",
		customer: { email: "fan@example.com" },
		lineItems: [],
		successUrl: "https://shop.example/thank-you",
		cancelUrl: "https://shop.example/checkout",
		...overrides,
	};
}

function paystackOk(data: unknown): Response {
	return new Response(JSON.stringify({ status: true, message: "ok", data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

// Paystack allows only `-`, `.`, `=` and alphanumerics in a transaction reference.
const PAYSTACK_REFERENCE = /^[A-Za-z0-9.=-]+$/;

describe("paystackPaymentProvider", () => {
	const credentials = { secretKey: "sk_test_1234567890abcdef" };

	describe("supportsCurrency", () => {
		it("supports the currencies Paystack settles", () => {
			expect(paystackPaymentProvider.supportsCurrency("KES")).toBe(true);
			expect(paystackPaymentProvider.supportsCurrency("ngn")).toBe(true);
			expect(paystackPaymentProvider.supportsCurrency(" GHS ")).toBe(true);
			expect(paystackPaymentProvider.supportsCurrency("ZAR")).toBe(true);
			expect(paystackPaymentProvider.supportsCurrency("USD")).toBe(true);
		});

		it("rejects other currencies", () => {
			expect(paystackPaymentProvider.supportsCurrency("EUR")).toBe(false);
			expect(paystackPaymentProvider.supportsCurrency("GBP")).toBe(false);
			expect(paystackPaymentProvider.supportsCurrency("")).toBe(false);
		});
	});

	describe("paystackReferenceFor", () => {
		it("produces a reference Paystack accepts from a core draft id", () => {
			const ref = paystackReferenceFor("0123456789abcdef0123456789abcdef");
			expect(ref).toBe("dc-0123456789abcdef0123456789abcdef");
			expect(ref).toMatch(PAYSTACK_REFERENCE);
		});

		it("replaces characters Paystack rejects", () => {
			expect(paystackReferenceFor("draft_pstk_1")).toMatch(PAYSTACK_REFERENCE);
		});
	});

	describe("initCheckout", () => {
		it("initialises a transaction with a valid reference and returns the redirect", async () => {
			let capturedUrl = "";
			let capturedBody: Record<string, unknown> = {};
			const ctx = makeMockRuntimeContext(async (url, init) => {
				capturedUrl = url;
				capturedBody = JSON.parse(String(init?.body));
				return paystackOk({
					authorization_url: "https://checkout.paystack.com/abc",
					access_code: "abc",
					reference: capturedBody.reference,
				});
			});

			const result = await paystackPaymentProvider.initCheckout(
				ctx,
				checkoutInput({ preferredChannels: ["card", "mpesa"] }),
				credentials,
			);

			expect(capturedUrl).toBe("https://api.paystack.co/transaction/initialize");
			expect(capturedBody.email).toBe("fan@example.com");
			expect(capturedBody.amount).toBe(250000);
			expect(capturedBody.currency).toBe("KES");
			expect(capturedBody.reference).toBe("dc-0123456789abcdef0123456789abcdef");
			expect(String(capturedBody.reference)).toMatch(PAYSTACK_REFERENCE);
			expect(capturedBody.callback_url).toBe("https://shop.example/thank-you");
			expect(capturedBody.channels).toEqual(["card", "mobile_money"]);
			expect((capturedBody.metadata as Record<string, string>).orderDraftId).toBe(
				"0123456789abcdef0123456789abcdef",
			);

			expect(result.kind).toBe("redirect");
			if (result.kind !== "redirect") throw new Error("expected redirect");
			expect(result.redirectUrl).toBe("https://checkout.paystack.com/abc");
			expect(result.checkoutReference).toBe("dc-0123456789abcdef0123456789abcdef");
		});

		it("throws before calling Paystack when the email is missing", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return new Response("{}");
			});
			await expect(
				paystackPaymentProvider.initCheckout(
					ctx,
					checkoutInput({ customer: { email: "" } }),
					credentials,
				),
			).rejects.toThrow("Paystack requires customer email to initialize checkout");
			expect(calls).toBe(0);
		});

		it("throws before calling Paystack when the email is malformed", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return new Response("{}");
			});
			await expect(
				paystackPaymentProvider.initCheckout(
					ctx,
					checkoutInput({ customer: { email: "invalid-email" } }),
					credentials,
				),
			).rejects.toThrow("Paystack requires a valid customer email to initialize checkout");
			expect(calls).toBe(0);
		});

		it("throws before calling Paystack for an unsupported currency", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return new Response("{}");
			});
			await expect(
				paystackPaymentProvider.initCheckout(ctx, checkoutInput({ currency: "EUR" }), credentials),
			).rejects.toThrow(/does not support currency EUR/);
			expect(calls).toBe(0);
		});

		it("throws before calling Paystack for subscription mode", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return new Response("{}");
			});
			await expect(
				paystackPaymentProvider.initCheckout(
					ctx,
					checkoutInput({ mode: "subscription" }),
					credentials,
				),
			).rejects.toThrow(/subscription/);
			expect(calls).toBe(0);
		});

		it("drops Stripe's session placeholder from the callback URL", async () => {
			let body: Record<string, unknown> = {};
			const ctx = makeMockRuntimeContext(async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return paystackOk({
					authorization_url: "https://checkout.paystack.com/x",
					reference: body.reference,
				});
			});
			await paystackPaymentProvider.initCheckout(
				ctx,
				checkoutInput({
					successUrl: "https://shop.example/thank-you/abc?session_id={CHECKOUT_SESSION_ID}&keep=1",
				}),
				credentials,
			);
			expect(body.callback_url).toBe("https://shop.example/thank-you/abc?keep=1");
		});

		it("refuses to call Paystack without the runtime's fetch", async () => {
			const ctx: PaymentProviderRuntimeContext = { log: { info() {}, warn() {}, error() {} } };
			await expect(
				paystackPaymentProvider.initCheckout(ctx, checkoutInput(), credentials),
			).rejects.toThrow(/ctx\.http\.fetch/);
		});

		it("surfaces a Paystack API error", async () => {
			const ctx = makeMockRuntimeContext(
				async () =>
					new Response(JSON.stringify({ status: false, message: "Invalid key" }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					}),
			);
			await expect(
				paystackPaymentProvider.initCheckout(ctx, checkoutInput(), credentials),
			).rejects.toThrow("Invalid key");
		});
	});

	describe("verifyWebhook", () => {
		async function sign(secret: string, payload: string): Promise<string> {
			const enc = new TextEncoder();
			const key = await crypto.subtle.importKey(
				"raw",
				enc.encode(secret),
				{ name: "HMAC", hash: "SHA-512" },
				false,
				["sign"],
			);
			const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
			return Array.from(new Uint8Array(sig))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		}

		it("accepts a valid HMAC-SHA512 signature over the raw body", async () => {
			const body = JSON.stringify({ event: "charge.success", data: { id: 123 } });
			const result = await paystackPaymentProvider.verifyWebhook({
				rawBody: body,
				signatureHeader: await sign(credentials.secretKey, body),
				secret: credentials.secretKey,
			});
			expect(result.ok).toBe(true);
		});

		it("rejects a signature made with another key", async () => {
			const body = JSON.stringify({ event: "charge.success", data: { id: 123 } });
			const result = await paystackPaymentProvider.verifyWebhook({
				rawBody: body,
				signatureHeader: await sign("sk_test_wrong_key", body),
				secret: credentials.secretKey,
			});
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("Signature mismatch");
		});

		it("rejects a body changed after signing", async () => {
			const body = JSON.stringify({ event: "charge.success", data: { amount: 100 } });
			const signature = await sign(credentials.secretKey, body);
			const result = await paystackPaymentProvider.verifyWebhook({
				rawBody: body.replace("100", "1"),
				signatureHeader: signature,
				secret: credentials.secretKey,
			});
			expect(result.ok).toBe(false);
		});

		it("rejects a missing signature or secret", async () => {
			expect(
				(
					await paystackPaymentProvider.verifyWebhook({
						rawBody: "{}",
						signatureHeader: "",
						secret: credentials.secretKey,
					})
				).ok,
			).toBe(false);
			expect(
				(
					await paystackPaymentProvider.verifyWebhook({
						rawBody: "{}",
						signatureHeader: "abc",
						secret: "",
					})
				).ok,
			).toBe(false);
		});
	});

	describe("parseWebhookEvent", () => {
		const successPayload = {
			event: "charge.success",
			data: {
				id: 99887766,
				reference: "dc-0123456789abcdef0123456789abcdef",
				amount: 350000,
				currency: "KES",
				status: "success",
				customer: {
					email: "captain@example.com",
					first_name: "Biko",
					last_name: "Adema",
					phone: "+254711223344",
				},
				channel: "mobile_money",
				metadata: { orderDraftId: "0123456789abcdef0123456789abcdef" },
			},
		};

		it("maps charge.success using the transaction reference, not the numeric id", () => {
			const parsed = paystackPaymentProvider.parseWebhookEvent(JSON.stringify(successPayload));
			expect(parsed.type).toBe("charge.succeeded");
			if (parsed.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
			expect(parsed.orderDraftId).toBe("0123456789abcdef0123456789abcdef");
			// `/transaction/verify/:reference` only accepts the reference, and core
			// passes paymentReference to getPaymentStatus before creating the order.
			expect(parsed.paymentReference).toBe("dc-0123456789abcdef0123456789abcdef");
			expect(parsed.checkoutReference).toBe("dc-0123456789abcdef0123456789abcdef");
			// Paystack sends no event id; an empty one makes core rely on its
			// per-payment unique index, so a failed delivery can be retried.
			expect(parsed.providerEventId).toBe("");
			expect(parsed.providerId).toBe("paystack");
			expect(parsed.amount).toBe(350000);
			expect(parsed.currency).toBe("KES");
			expect(parsed.customer.email).toBe("captain@example.com");
			expect(parsed.customer.name).toBe("Biko Adema");
			expect(parsed.customer.phone).toBe("+254711223344");
			expect(parsed.channel).toBe("M-Pesa");
		});

		it("recovers the draft id from the reference when metadata is missing", () => {
			const { metadata: _omitted, ...data } = successPayload.data;
			const parsed = paystackPaymentProvider.parseWebhookEvent(
				JSON.stringify({ ...successPayload, data }),
			);
			expect(parsed.type).toBe("charge.succeeded");
			if (parsed.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
			expect(parsed.orderDraftId).toBe("0123456789abcdef0123456789abcdef");
		});

		it("reads metadata sent back as a JSON string", () => {
			const parsed = paystackPaymentProvider.parseWebhookEvent(
				JSON.stringify({
					...successPayload,
					data: {
						...successPayload.data,
						reference: "not-ours",
						metadata: JSON.stringify({ orderDraftId: "draft-from-string" }),
					},
				}),
			);
			expect(parsed.type).toBe("charge.succeeded");
			if (parsed.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
			expect(parsed.orderDraftId).toBe("draft-from-string");
		});

		it("does not guess a draft id from a reference it did not issue", () => {
			const { metadata: _omitted, ...data } = successPayload.data;
			const parsed = paystackPaymentProvider.parseWebhookEvent(
				JSON.stringify({ ...successPayload, data: { ...data, reference: "T685312322670591" } }),
			);
			expect(parsed.type).toBe("unhandled");
		});

		it("does not invent a currency when Paystack omits it", () => {
			const { currency: _omitted, ...data } = successPayload.data;
			const parsed = paystackPaymentProvider.parseWebhookEvent(
				JSON.stringify({ ...successPayload, data }),
			);
			expect(parsed.type).toBe("unhandled");
		});

		it("leaves events Paystack does not document for this flow unhandled", () => {
			const parsed = paystackPaymentProvider.parseWebhookEvent(
				JSON.stringify({
					event: "charge.failed",
					data: { ...successPayload.data, status: "failed" },
				}),
			);
			expect(parsed.type).toBe("unhandled");
		});

		it("returns unhandled on unparseable JSON without throwing", () => {
			const parsed = paystackPaymentProvider.parseWebhookEvent("invalid-json-body");
			expect(parsed.type).toBe("unhandled");
			if (parsed.type !== "unhandled") throw new Error("expected unhandled");
			expect(parsed.providerEventType).toBe("unparseable");
		});

		it("returns unhandled when the charge has no orderDraftId", () => {
			const parsed = paystackPaymentProvider.parseWebhookEvent(
				JSON.stringify({
					event: "charge.success",
					data: { id: 554433, reference: "no-draft", amount: 1000, currency: "KES" },
				}),
			);
			expect(parsed.type).toBe("unhandled");
		});
	});

	describe("getPaymentStatus", () => {
		it("verifies by reference and returns the reference", async () => {
			let calledUrl = "";
			const ctx = makeMockRuntimeContext(async (url) => {
				calledUrl = url;
				return paystackOk({
					id: 776655,
					status: "success",
					reference: "dc-abc",
					amount: 450000,
					currency: "KES",
				});
			});

			const status = await paystackPaymentProvider.getPaymentStatus?.(ctx, "dc-abc", credentials);

			expect(calledUrl).toBe("https://api.paystack.co/transaction/verify/dc-abc");
			expect(status?.status).toBe("succeeded");
			expect(status?.paymentReference).toBe("dc-abc");
			expect(status?.amount).toBe(450000);
			expect(status?.currency).toBe("KES");
		});

		it("maps failed and abandoned transactions", async () => {
			for (const [paystackStatus, expected] of [
				["failed", "failed"],
				["abandoned", "pending"],
				["ongoing", "pending"],
			] as const) {
				const ctx = makeMockRuntimeContext(async () =>
					paystackOk({
						id: 1,
						status: paystackStatus,
						reference: "dc-x",
						amount: 1,
						currency: "KES",
					}),
				);
				const status = await paystackPaymentProvider.getPaymentStatus?.(ctx, "dc-x", credentials);
				expect(status?.status).toBe(expected);
			}
		});
	});

	describe("refund", () => {
		it("refunds by transaction reference with the request id in the merchant note", async () => {
			let capturedBody: Record<string, unknown> = {};
			const ctx = makeMockRuntimeContext(async (url, init) => {
				expect(url).toBe("https://api.paystack.co/refund");
				capturedBody = JSON.parse(String(init?.body));
				return paystackOk({ id: 990011, status: "processed", amount: 250000, currency: "KES" });
			});

			const result = await paystackPaymentProvider.refund(
				ctx,
				{
					refundRequestId: "refund-req-1",
					paymentReference: "dc-0123456789abcdef0123456789abcdef",
					amount: 250000,
					currency: "KES",
					reason: "Event cancelled",
				},
				credentials,
			);

			expect(capturedBody.transaction).toBe("dc-0123456789abcdef0123456789abcdef");
			expect(capturedBody.amount).toBe(250000);
			expect(capturedBody.currency).toBe("KES");
			expect(capturedBody.merchant_note).toBe("refund-req-1: Event cancelled");
			expect(result.status).toBe("succeeded");
			expect(result.providerRefundId).toBe("990011");
			expect(result.refundRequestId).toBe("refund-req-1");
		});

		it("reports a queued refund as pending", async () => {
			const ctx = makeMockRuntimeContext(async () =>
				paystackOk({ id: 1, status: "pending", amount: 100, currency: "KES" }),
			);
			const result = await paystackPaymentProvider.refund(
				ctx,
				{ refundRequestId: "r", paymentReference: "dc-x", amount: 100, currency: "KES" },
				credentials,
			);
			expect(result.status).toBe("pending");
		});

		it("throws when refundRequestId is missing", async () => {
			const ctx = makeMockRuntimeContext(async () => new Response());
			await expect(
				paystackPaymentProvider.refund(
					ctx,
					{ refundRequestId: "", paymentReference: "dc-x", amount: 1000, currency: "KES" },
					credentials,
				),
			).rejects.toThrow(/refundRequestId/);
		});
	});

	describe("formatAmount", () => {
		it("formats minor units as major units with the currency code", () => {
			expect(paystackPaymentProvider.formatAmount(250000, "KES")).toBe("KES 2500.00");
			expect(paystackPaymentProvider.formatAmount(999, "usd")).toBe("USD 9.99");
		});
	});
});

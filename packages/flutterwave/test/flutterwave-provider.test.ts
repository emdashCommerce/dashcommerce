import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	InitCheckoutInput,
	PaymentProviderRuntimeContext,
} from "@dashcommerce/core/payment-provider";
import {
	flutterwavePaymentProvider,
	flutterwaveReferenceFor,
	toMajorUnits,
	toMinorUnits,
} from "../src/provider";

function fixture(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8")) as Record<
		string,
		unknown
	>;
}

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

function flutterwaveOk(data: unknown, meta?: unknown): Response {
	return new Response(
		JSON.stringify({ status: "success", message: "ok", data, ...(meta ? { meta } : {}) }),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function flutterwaveError(message: string, status = 400): Response {
	return new Response(JSON.stringify({ status: "error", message, data: null }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const TX_REFERENCE = /^[A-Za-z0-9.=-]+$/;

describe("flutterwavePaymentProvider", () => {
	const credentials = { secretKey: "FLWSECK_TEST-1234567890abcdef-X" };

	describe("declared to core", () => {
		it("is a hosted and on-page provider that claims the verif-hash header", () => {
			expect(flutterwavePaymentProvider.id).toBe("flutterwave");
			expect(flutterwavePaymentProvider.checkoutStyles).toEqual(["hosted", "on_page"]);
			expect(flutterwavePaymentProvider.webhookHeaders).toEqual(["verif-hash"]);
			expect(flutterwavePaymentProvider.collectsCustomerDetails).toBeUndefined();
			expect(flutterwavePaymentProvider.capabilities).toEqual({
				coupons: true,
				connect: false,
				subscriptions: false,
				splits: true,
			});
		});

		it("accepts Flutterwave secret keys, a public key and any secret hash", () => {
			const fields = flutterwavePaymentProvider.credentialFields;
			expect(fields?.secretKey?.prefixes).toEqual(["FLWSECK_TEST-", "FLWSECK-"]);
			expect(fields?.webhookSecret?.prefixes).toEqual([]);
			expect(fields?.publicKey?.prefixes).toEqual(["FLWPUBK_TEST-", "FLWPUBK-"]);
		});
	});

	describe("supportsCurrency", () => {
		it("supports the currencies Flutterwave collects in", () => {
			for (const currency of ["NGN", "KES", "GHS", "ZAR", "USD", "GBP", "EUR", "UGX", "TZS"]) {
				expect(flutterwavePaymentProvider.supportsCurrency(currency)).toBe(true);
			}
			expect(flutterwavePaymentProvider.supportsCurrency("ngn")).toBe(true);
			expect(flutterwavePaymentProvider.supportsCurrency(" KES ")).toBe(true);
		});

		it("rejects other currencies", () => {
			expect(flutterwavePaymentProvider.supportsCurrency("JPY")).toBe(false);
			expect(flutterwavePaymentProvider.supportsCurrency("")).toBe(false);
		});
	});

	describe("amount conversion", () => {
		it("converts core minor units to Flutterwave major units", () => {
			expect(toMajorUnits(250000)).toBe(2500);
			expect(toMajorUnits(1)).toBe(0.01);
			expect(toMajorUnits(0)).toBe(0);
		});

		it("converts Flutterwave major units back to core minor units", () => {
			expect(toMinorUnits(2500)).toBe(250000);
			expect(toMinorUnits("0.01")).toBe(1);
			expect(toMinorUnits(12.345)).toBe(1235);
		});

		it("refuses a negative or fractional minor amount", () => {
			expect(() => toMajorUnits(-1)).toThrow(/non-negative integer/);
			expect(() => toMajorUnits(1.5)).toThrow(/non-negative integer/);
		});

		it("ignores a missing or malformed major amount", () => {
			expect(toMinorUnits(undefined)).toBeUndefined();
			expect(toMinorUnits("abc")).toBeUndefined();
			expect(toMinorUnits(-1)).toBeUndefined();
		});
	});

	describe("flutterwaveReferenceFor", () => {
		it("produces a reference Flutterwave accepts from a core draft id", () => {
			const ref = flutterwaveReferenceFor("0123456789abcdef0123456789abcdef");
			expect(ref).toBe("dc-0123456789abcdef0123456789abcdef");
			expect(ref).toMatch(TX_REFERENCE);
		});

		it("replaces characters Flutterwave rejects", () => {
			expect(flutterwaveReferenceFor("draft_flw_1")).toMatch(TX_REFERENCE);
		});
	});

	describe("initCheckout", () => {
		it("creates a hosted payment in major units and returns the link", async () => {
			let capturedUrl = "";
			let capturedBody: Record<string, unknown> = {};
			const ctx = makeMockRuntimeContext(async (url, init) => {
				capturedUrl = url;
				capturedBody = JSON.parse(String(init?.body));
				return flutterwaveOk({
					link: "https://checkout.flutterwave.com/v3/hosted/pay/test-link",
				});
			});

			const result = await flutterwavePaymentProvider.initCheckout(
				ctx,
				checkoutInput({ preferredChannels: ["card", "mpesa"] }),
				credentials,
			);

			expect(capturedUrl).toBe("https://api.flutterwave.com/v3/payments");
			expect(capturedBody.tx_ref).toBe("dc-0123456789abcdef0123456789abcdef");
			expect(String(capturedBody.tx_ref)).toMatch(TX_REFERENCE);
			expect(capturedBody.amount).toBe(2500);
			expect(capturedBody.currency).toBe("KES");
			expect(capturedBody.redirect_url).toBe("https://shop.example/thank-you");
			expect(capturedBody.payment_options).toBe("card,mpesa");
			expect((capturedBody.customer as Record<string, string>).email).toBe("fan@example.com");
			expect((capturedBody.meta as Record<string, string>).orderDraftId).toBe(
				"0123456789abcdef0123456789abcdef",
			);

			expect(result.kind).toBe("redirect");
			if (result.kind !== "redirect") throw new Error("expected redirect");
			expect(result.redirectUrl).toBe("https://checkout.flutterwave.com/v3/hosted/pay/test-link");
			expect(result.checkoutReference).toBe("dc-0123456789abcdef0123456789abcdef");
		});

		it("resolves a generic mobile-money hint with the cart's currency", async () => {
			let body: Record<string, unknown> = {};
			const ctx = makeMockRuntimeContext(async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return flutterwaveOk({ link: "https://checkout.flutterwave.com/v3/hosted/pay/x" });
			});
			await flutterwavePaymentProvider.initCheckout(
				ctx,
				checkoutInput({ currency: "GHS", preferredChannels: ["mobile_money"] }),
				credentials,
			);
			expect(body.payment_options).toBe("mobilemoneyghana");
		});

		it("passes the customer's name and phone when the cart has them", async () => {
			let body: Record<string, unknown> = {};
			const ctx = makeMockRuntimeContext(async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return flutterwaveOk({ link: "https://checkout.flutterwave.com/v3/hosted/pay/x" });
			});
			await flutterwavePaymentProvider.initCheckout(
				ctx,
				checkoutInput({
					customer: { email: "fan@example.com", phone: "+254700000000" },
					shippingAddress: { firstName: "Aidi", lastName: "Onyango" },
				}),
				credentials,
			);
			expect(body.customer).toEqual({
				email: "fan@example.com",
				name: "Aidi Onyango",
				phonenumber: "+254700000000",
			});
		});

		it("strips Stripe's session placeholder from the return URL", async () => {
			let body: Record<string, unknown> = {};
			const ctx = makeMockRuntimeContext(async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return flutterwaveOk({ link: "https://checkout.flutterwave.com/v3/hosted/pay/x" });
			});
			await flutterwavePaymentProvider.initCheckout(
				ctx,
				checkoutInput({
					successUrl: "https://shop.example/thank-you?session_id={CHECKOUT_SESSION_ID}&utm=email",
				}),
				credentials,
			);
			const callback = new URL(String(body.redirect_url));
			expect(callback.searchParams.get("session_id")).toBeNull();
			expect(callback.searchParams.get("utm")).toBe("email");
		});

		it("throws before calling Flutterwave when the email is missing", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return new Response("{}");
			});
			await expect(
				flutterwavePaymentProvider.initCheckout(
					ctx,
					checkoutInput({ customer: { email: "" } }),
					credentials,
				),
			).rejects.toThrow("Flutterwave requires customer email to initialize checkout");
			expect(calls).toBe(0);
		});

		it("throws before calling Flutterwave when the email is malformed", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return new Response("{}");
			});
			await expect(
				flutterwavePaymentProvider.initCheckout(
					ctx,
					checkoutInput({ customer: { email: "invalid-email" } }),
					credentials,
				),
			).rejects.toThrow("Flutterwave requires a valid customer email to initialize checkout");
			expect(calls).toBe(0);
		});

		it("throws before calling Flutterwave for an unsupported currency", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return new Response("{}");
			});
			await expect(
				flutterwavePaymentProvider.initCheckout(
					ctx,
					checkoutInput({ currency: "JPY" }),
					credentials,
				),
			).rejects.toThrow(/does not support currency JPY/);
			expect(calls).toBe(0);
		});

		it("throws before calling Flutterwave for subscription mode", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return new Response("{}");
			});
			await expect(
				flutterwavePaymentProvider.initCheckout(
					ctx,
					checkoutInput({ mode: "subscription" }),
					credentials,
				),
			).rejects.toThrow(/does not support subscription checkout/);
			expect(calls).toBe(0);
		});

		it("charges the discounted total when the cart has a coupon", async () => {
			let body: Record<string, unknown> = {};
			const ctx = makeMockRuntimeContext(async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return flutterwaveOk({ link: "https://checkout.flutterwave.com/v3/hosted/pay/x" });
			});
			// 10,000 minor with a 10% cart discount: core sends the net total.
			await flutterwavePaymentProvider.initCheckout(
				ctx,
				checkoutInput({ amount: 9_000 }),
				credentials,
			);
			expect(body.amount).toBe(90);
			expect(flutterwavePaymentProvider.capabilities?.coupons).toBe(true);
		});

		it("fails when Flutterwave returns no link", async () => {
			const ctx = makeMockRuntimeContext(async () => flutterwaveOk({}));
			await expect(
				flutterwavePaymentProvider.initCheckout(ctx, checkoutInput(), credentials),
			).rejects.toThrow("Flutterwave did not return a hosted checkout link");
		});

		describe("on-page (Flutterwave Inline)", () => {
			const withPublicKey = { ...credentials, publicKey: "FLWPUBK_TEST-abc123-X" };

			it("returns the browser client data without calling the API", async () => {
				let calls = 0;
				const ctx = makeMockRuntimeContext(async () => {
					calls++;
					return flutterwaveOk({});
				});

				const result = await flutterwavePaymentProvider.initCheckout(
					ctx,
					checkoutInput({ checkoutStyle: "on_page" }),
					withPublicKey,
				);

				expect(calls).toBe(0);
				expect(result.kind).toBe("on_page");
				if (result.kind !== "on_page") throw new Error("expected on_page");
				expect(result.checkoutReference).toBe("dc-0123456789abcdef0123456789abcdef");
				expect(result.client).toEqual({
					publicKey: "FLWPUBK_TEST-abc123-X",
					txRef: "dc-0123456789abcdef0123456789abcdef",
					amount: "2500",
					currency: "KES",
					customerEmail: "fan@example.com",
					orderDraftId: "0123456789abcdef0123456789abcdef",
				});
			});

			it("passes the customer's name, phone and channel hints", async () => {
				const ctx = makeMockRuntimeContext(async () => flutterwaveOk({}));
				const result = await flutterwavePaymentProvider.initCheckout(
					ctx,
					checkoutInput({
						checkoutStyle: "on_page",
						preferredChannels: ["card", "mpesa"],
						customer: { email: "fan@example.com", phone: "+254700000000" },
						shippingAddress: { firstName: "Aidi", lastName: "Onyango" },
					}),
					withPublicKey,
				);
				if (result.kind !== "on_page") throw new Error("expected on_page");
				expect(result.client.customerName).toBe("Aidi Onyango");
				expect(result.client.customerPhone).toBe("+254700000000");
				expect(result.client.paymentOptions).toBe("card,mpesa");
			});

			it("refuses on-page checkout without the public key", async () => {
				const ctx = makeMockRuntimeContext(async () => flutterwaveOk({}));
				await expect(
					flutterwavePaymentProvider.initCheckout(
						ctx,
						checkoutInput({ checkoutStyle: "on_page" }),
						credentials,
					),
				).rejects.toThrow(/needs the public key/);
			});

			it("still validates the cart before asking for a public key", async () => {
				const ctx = makeMockRuntimeContext(async () => flutterwaveOk({}));
				await expect(
					flutterwavePaymentProvider.initCheckout(
						ctx,
						checkoutInput({ checkoutStyle: "on_page", currency: "JPY" }),
						withPublicKey,
					),
				).rejects.toThrow(/does not support currency JPY/);
			});
		});

		describe("split payments", () => {
			const allocations = [
				{ vendorId: "v1", accountReference: "RS_V1", amountMinor: 90_000 },
				{ vendorId: "v2", accountReference: "RS_V2", amountMinor: 60_000 },
			];

			it("sends each allocation as a flat subaccount charge", async () => {
				let body: Record<string, unknown> = {};
				const ctx = makeMockRuntimeContext(async (_url, init) => {
					body = JSON.parse(String(init?.body));
					return flutterwaveOk({ link: "https://checkout.flutterwave.com/v3/hosted/pay/x" });
				});

				await flutterwavePaymentProvider.initCheckout(
					ctx,
					checkoutInput({
						amount: 200_000,
						allocations,
						platformRemainderMinor: 50_000,
					}),
					credentials,
				);

				expect(body.subaccounts).toEqual([
					{ id: "RS_V1", transaction_charge_type: "flat_subaccount", transaction_charge: 900 },
					{ id: "RS_V2", transaction_charge_type: "flat_subaccount", transaction_charge: 600 },
				]);
			});

			it("passes the split to Inline as JSON in the client payload", async () => {
				const ctx = makeMockRuntimeContext(async () => flutterwaveOk({}));
				const result = await flutterwavePaymentProvider.initCheckout(
					ctx,
					checkoutInput({
						checkoutStyle: "on_page",
						amount: 200_000,
						allocations,
						platformRemainderMinor: 50_000,
					}),
					{ ...credentials, publicKey: "FLWPUBK_TEST-abc123-X" },
				);
				if (result.kind !== "on_page") throw new Error("expected on_page");
				expect(JSON.parse(result.client.subaccounts ?? "[]")).toEqual([
					{ id: "RS_V1", transaction_charge_type: "flat_subaccount", transaction_charge: 900 },
					{ id: "RS_V2", transaction_charge_type: "flat_subaccount", transaction_charge: 600 },
				]);
			});

			it("sends no subaccounts for a cart without vendor allocations", async () => {
				let body: Record<string, unknown> = {};
				const ctx = makeMockRuntimeContext(async (_url, init) => {
					body = JSON.parse(String(init?.body));
					return flutterwaveOk({ link: "https://checkout.flutterwave.com/v3/hosted/pay/x" });
				});
				await flutterwavePaymentProvider.initCheckout(ctx, checkoutInput(), credentials);
				expect(body.subaccounts).toBeUndefined();
			});

			it("refuses an empty account, a zero share or shares above the total", async () => {
				const ctx = makeMockRuntimeContext(async () => flutterwaveOk({}));
				await expect(
					flutterwavePaymentProvider.initCheckout(
						ctx,
						checkoutInput({
							allocations: [{ vendorId: "v1", accountReference: " ", amountMinor: 1_000 }],
						}),
						credentials,
					),
				).rejects.toThrow(/no Flutterwave subaccount id/);

				await expect(
					flutterwavePaymentProvider.initCheckout(
						ctx,
						checkoutInput({
							allocations: [{ vendorId: "v1", accountReference: "RS_V1", amountMinor: 0 }],
						}),
						credentials,
					),
				).rejects.toThrow(/positive integer/);

				await expect(
					flutterwavePaymentProvider.initCheckout(
						ctx,
						checkoutInput({
							amount: 100_000,
							allocations: [
								{ vendorId: "v1", accountReference: "RS_V1", amountMinor: 100_000 },
								{ vendorId: "v2", accountReference: "RS_V2", amountMinor: 1 },
							],
						}),
						credentials,
					),
				).rejects.toThrow(/exceed the checkout amount/);
			});
		});
	});

	describe("verifyWebhook", () => {
		it("accepts the configured secret hash", async () => {
			const result = await flutterwavePaymentProvider.verifyWebhook({
				rawBody: "{}",
				signatureHeader: "my-secret-hash",
				secret: "my-secret-hash",
			});
			expect(result.ok).toBe(true);
		});

		it("refuses a different hash", async () => {
			const result = await flutterwavePaymentProvider.verifyWebhook({
				rawBody: "{}",
				signatureHeader: "not-the-hash",
				secret: "my-secret-hash",
			});
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("verif-hash");
		});

		it("refuses a missing header or a missing secret", async () => {
			expect(
				(
					await flutterwavePaymentProvider.verifyWebhook({
						rawBody: "{}",
						signatureHeader: "",
						secret: "my-secret-hash",
					})
				).ok,
			).toBe(false);
			expect(
				(
					await flutterwavePaymentProvider.verifyWebhook({
						rawBody: "{}",
						signatureHeader: "my-secret-hash",
						secret: "",
					})
				).ok,
			).toBe(false);
		});
	});

	describe("parseWebhookEvent", () => {
		const draftId = "0123456789abcdef0123456789abcdef";

		function chargeEvent(overrides: Record<string, unknown> = {}) {
			return {
				event: "charge.completed",
				"event.type": "CARD_TRANSACTION",
				data: {
					id: 285959875,
					tx_ref: `dc-${draftId}`,
					flw_ref: "FLW-MOCK-123",
					amount: 1500,
					currency: "KES",
					charged_amount: 1500,
					status: "successful",
					payment_type: "mpesa",
					processor_response: "Approved",
					customer: {
						id: 1,
						name: "Aidi Onyango",
						phone_number: "+254700000000",
						email: "fan@example.com",
					},
					meta: { orderDraftId: draftId },
					...overrides,
				},
			};
		}

		it("normalises a successful charge, converting the amount to minor units", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(JSON.stringify(chargeEvent()));
			expect(event.type).toBe("charge.succeeded");
			if (event.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
			expect(event.orderDraftId).toBe(draftId);
			expect(event.providerId).toBe("flutterwave");
			expect(event.providerEventId).toBe("charge.completed:285959875:successful");
			expect(event.paymentReference).toBe("285959875");
			expect(event.checkoutReference).toBe(`dc-${draftId}`);
			expect(event.amount).toBe(150000);
			expect(event.currency).toBe("KES");
			expect(event.channel).toBe("M-Pesa");
			expect(event.customer).toEqual({
				email: "fan@example.com",
				name: "Aidi Onyango",
				phone: "+254700000000",
			});
		});

		it("reads meta when Flutterwave sends it as a JSON string", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify(chargeEvent({ meta: JSON.stringify({ orderDraftId: draftId }) })),
			);
			expect(event.type).toBe("charge.succeeded");
		});

		it("finds the draft from the reference when meta is absent", () => {
			const payload = chargeEvent();
			const { meta: _meta, ...data } = payload.data as Record<string, unknown>;
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify({ ...payload, data }),
			);
			expect(event.type).toBe("charge.succeeded");
			if (event.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
			expect(event.orderDraftId).toBe(draftId);
		});

		it("parses a charge.completed built from a real test-mode verify response", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify({
					event: "charge.completed",
					"event.type": "M-PESA_TRANSACTION",
					data: fixture("verify-successful-mpesa.json"),
				}),
			);
			expect(event.type).toBe("charge.succeeded");
			if (event.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
			expect(event.amount).toBe(150000);
			expect(event.currency).toBe("KES");
			expect(event.channel).toBe("M-Pesa");
			expect(event.paymentReference).toBe("10633588");
			expect(event.customer.email).toBe("buyer@example.com");
			expect(event.orderDraftId).toBe("0123456789abcdef0123456789abcdef");
		});

		it("parses a real split payment and keeps the split settlement in raw", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify({
					event: "charge.completed",
					"event.type": "M-PESA_TRANSACTION",
					data: fixture("verify-split-mpesa.json"),
				}),
			);
			expect(event.type).toBe("charge.succeeded");
			if (event.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
			expect(event.orderDraftId).toBe("0123456789abcdef0123456789abcdef");
			expect(event.amount).toBe(150000);
			expect(event.paymentReference).toBe("10633643");
			expect(event.splitSettlement).toMatchObject({
				allocations: [
					{
						accountReference: "RS_CD57DC0FB468D17CC4EF6E28A2B70A62",
						amountMinor: 90_000,
					},
					{
						accountReference: "RS_A075186F846E729B97277DA02E6CD019",
						amountMinor: 45_000,
					},
				],
				platformRemainderMinor: 7_650,
				providerFeeMinor: 7_350,
				currency: "KES",
			});
			const raw = event.raw as { data: { meta: { split_settlement_info: string } } };
			const split = JSON.parse(raw.data.meta.split_settlement_info) as Record<
				string,
				{ subaccount_earning?: number }
			> & { total_merchant_commission?: number };
			expect(split.RS_CD57DC0FB468D17CC4EF6E28A2B70A62?.subaccount_earning).toBe(900);
			expect(split.RS_A075186F846E729B97277DA02E6CD019?.subaccount_earning).toBe(450);
			expect(split.total_merchant_commission).toBe(76.5);
		});

		it("parses a refund object as Flutterwave really sends it", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify(fixture("refund-completed.json")),
			);
			expect(event.type).toBe("refund.updated");
			if (event.type !== "refund.updated") throw new Error("expected refund.updated");
			expect(event.providerRefundId).toBe("115037");
			expect(event.providerEventId).toBe("refund:115037:succeeded");
			expect(event.status).toBe("succeeded");
		});

		it("normalises a failed charge", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify(chargeEvent({ status: "failed", processor_response: "insufficient funds" })),
			);
			expect(event.type).toBe("charge.failed");
			if (event.type !== "charge.failed") throw new Error("expected charge.failed");
			expect(event.orderDraftId).toBe(draftId);
			expect(event.providerEventId).toBe("charge.completed:285959875:failed");
			expect(event.reason).toBe("insufficient funds");
		});

		it("leaves a pending charge unhandled", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify(chargeEvent({ status: "pending" })),
			);
			expect(event.type).toBe("unhandled");
		});

		it("normalises the refund webhook, which has no event field", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify({
					id: 99025,
					AmountRefunded: 100,
					status: "completed",
					FlwRef: "4687213286",
					TransactionId: 9231836,
					createdAt: "2026-01-30T08:35:45.000Z",
				}),
			);
			expect(event.type).toBe("refund.updated");
			if (event.type !== "refund.updated") throw new Error("expected refund.updated");
			expect(event.providerId).toBe("flutterwave");
			expect(event.providerRefundId).toBe("99025");
			expect(event.providerEventId).toBe("refund:99025:succeeded");
			expect(event.status).toBe("succeeded");
		});

		it("maps a pending refund and keeps each status a separate event", () => {
			const event = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify({
					id: 99025,
					AmountRefunded: 100,
					status: "pending-momo",
					TransactionId: 9231836,
				}),
			);
			if (event.type !== "refund.updated") throw new Error("expected refund.updated");
			expect(event.status).toBe("pending");
			expect(event.providerEventId).toBe("refund:99025:pending");
		});

		it("accepts a string refund id and an event wrapper", () => {
			const bare = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify({ id: "99025", AmountRefunded: 100, status: "completed" }),
			);
			if (bare.type !== "refund.updated") throw new Error("expected refund.updated");
			expect(bare.providerRefundId).toBe("99025");

			const wrapped = flutterwavePaymentProvider.parseWebhookEvent(
				JSON.stringify({ event: "refund.completed", data: { id: 99025, status: "completed" } }),
			);
			if (wrapped.type !== "refund.updated") throw new Error("expected refund.updated");
			expect(wrapped.providerRefundId).toBe("99025");
			expect(wrapped.status).toBe("succeeded");
		});

		it("leaves malformed, unparseable and unknown events unhandled", () => {
			expect(flutterwavePaymentProvider.parseWebhookEvent("not json").type).toBe("unhandled");
			expect(flutterwavePaymentProvider.parseWebhookEvent("null").type).toBe("unhandled");
			expect(flutterwavePaymentProvider.parseWebhookEvent("{}").type).toBe("unhandled");
			expect(
				flutterwavePaymentProvider.parseWebhookEvent(
					JSON.stringify({ event: "transfer.completed", data: {} }),
				).type,
			).toBe("unhandled");
		});
	});

	describe("getPaymentStatus", () => {
		it("verifies by numeric transaction id", async () => {
			let requested = "";
			const ctx = makeMockRuntimeContext(async (url) => {
				requested = url;
				return flutterwaveOk({
					id: 285959875,
					tx_ref: "dc-abc",
					amount: 1500,
					currency: "KES",
					status: "successful",
					processor_response: "Approved",
				});
			});

			const result = await flutterwavePaymentProvider.getPaymentStatus?.(
				ctx,
				"285959875",
				credentials,
			);
			expect(requested).toBe("https://api.flutterwave.com/v3/transactions/285959875/verify");
			expect(result).toEqual({
				status: "succeeded",
				paymentReference: "285959875",
				amount: 150000,
				currency: "KES",
				reason: "Approved",
			});
		});

		it("verifies a reference through verify_by_reference", async () => {
			let requested = "";
			const ctx = makeMockRuntimeContext(async (url) => {
				requested = url;
				return flutterwaveOk({
					id: 285959875,
					tx_ref: "dc-abc",
					amount: "1500",
					currency: "kes",
					status: "failed",
				});
			});

			const result = await flutterwavePaymentProvider.getPaymentStatus?.(
				ctx,
				"dc-abc",
				credentials,
			);
			expect(requested).toBe(
				"https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=dc-abc",
			);
			expect(result?.status).toBe("failed");
			expect(result?.amount).toBe(150000);
			expect(result?.currency).toBe("KES");
		});

		it("treats an unknown status as pending, never as paid", async () => {
			const ctx = makeMockRuntimeContext(async () =>
				flutterwaveOk({ id: 1, status: "weird", amount: 10, currency: "NGN" }),
			);
			const result = await flutterwavePaymentProvider.getPaymentStatus?.(ctx, "1", credentials);
			expect(result?.status).toBe("pending");
			expect(result?.reason).toContain("Unrecognised Flutterwave status");
		});

		it("fails without a reference and does not call Flutterwave", async () => {
			let calls = 0;
			const ctx = makeMockRuntimeContext(async () => {
				calls++;
				return flutterwaveOk({});
			});
			const result = await flutterwavePaymentProvider.getPaymentStatus?.(ctx, " ", credentials);
			expect(result?.status).toBe("failed");
			expect(calls).toBe(0);
		});
	});

	describe("refund", () => {
		function refundRuntime() {
			const refunds: Array<Record<string, unknown>> = [];
			let nextId = 8612;
			const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

			const ctx = makeMockRuntimeContext(async (url, init) => {
				const { pathname, searchParams } = new URL(url);
				const method = init?.method ?? "GET";
				const body = init?.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: undefined;
				calls.push({ method, path: pathname, ...(body ? { body } : {}) });

				if (pathname === "/v3/refunds") {
					const page = Number(searchParams.get("page") ?? "1");
					return flutterwaveOk(page === 1 ? refunds : [], {
						page_info: { current_page: page, total_pages: 1, page_size: 20 },
					});
				}
				const match = /^\/v3\/transactions\/(\d+)\/refund$/.exec(pathname);
				if (match) {
					const transactionId = Number(match[1]);
					const refund = {
						id: nextId++,
						transaction_id: transactionId,
						amount_refunded: body?.amount,
						status: "completed",
						comment: body?.comments ?? null,
						created_at: new Date(Date.UTC(2026, 10, 19, 2, refunds.length)).toISOString(),
					};
					refunds.push(refund);
					return flutterwaveOk(refund);
				}
				return flutterwaveError("Not found", 404);
			});

			return { ctx, refunds, calls };
		}

		it("refunds in major units and tags the comment with the request id", async () => {
			const { ctx, refunds, calls } = refundRuntime();
			const result = await flutterwavePaymentProvider.refund(
				ctx,
				{
					paymentReference: "908790",
					refundRequestId: "refund-req-1",
					amount: 50000,
					currency: "KES",
					reason: "out of stock",
				},
				credentials,
			);

			const create = calls.find((c) => c.method === "POST");
			expect(create?.path).toBe("/v3/transactions/908790/refund");
			expect(create?.body?.amount).toBe(500);
			expect(create?.body?.comments).toBe("out of stock (refundRequestId=refund-req-1)");
			expect(refunds).toHaveLength(1);
			expect(result).toEqual({
				providerRefundId: "8612",
				refundRequestId: "refund-req-1",
				status: "succeeded",
				amount: 50000,
				currency: "KES",
			});
		});

		it("returns the first refund on a retry instead of creating another", async () => {
			const { ctx, refunds, calls } = refundRuntime();
			const input = {
				paymentReference: "908790",
				refundRequestId: "refund-req-1",
				amount: 50000,
				currency: "KES",
			};
			const first = await flutterwavePaymentProvider.refund(ctx, input, credentials);
			const retry = await flutterwavePaymentProvider.refund(ctx, input, credentials);

			expect(retry.providerRefundId).toBe(first.providerRefundId);
			expect(refunds).toHaveLength(1);
			expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
		});

		it("creates a new refund for a different request id", async () => {
			const { ctx, refunds } = refundRuntime();
			await flutterwavePaymentProvider.refund(
				ctx,
				{
					paymentReference: "908790",
					refundRequestId: "refund-req-1",
					amount: 50000,
					currency: "KES",
				},
				credentials,
			);
			await flutterwavePaymentProvider.refund(
				ctx,
				{
					paymentReference: "908790",
					refundRequestId: "refund-req-2",
					amount: 50000,
					currency: "KES",
				},
				credentials,
			);
			expect(refunds).toHaveLength(2);
		});

		it("retries a request whose earlier refund failed", async () => {
			const { ctx, refunds, calls } = refundRuntime();
			refunds.push({
				id: 7000,
				transaction_id: 908790,
				amount_refunded: 500,
				status: "failed",
				comment: "(refundRequestId=refund-req-1)",
				created_at: "2026-11-19T01:00:00.000Z",
			});

			await flutterwavePaymentProvider.refund(
				ctx,
				{
					paymentReference: "908790",
					refundRequestId: "refund-req-1",
					amount: 50000,
					currency: "KES",
				},
				credentials,
			);
			expect(refunds).toHaveLength(2);
			expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
		});

		it("still refunds when the refund history is not available to the key", async () => {
			// A real test-mode account (24 Nov 2026) answered
			// 400 {"message":"unauthorized"} for GET /v3/refunds while it could
			// create refunds. Refunds must not be blocked by that.
			const paths: string[] = [];
			const ctx = makeMockRuntimeContext(async (url) => {
				const { pathname } = new URL(url);
				paths.push(pathname);
				if (pathname === "/v3/refunds") return flutterwaveError("unauthorized", 400);
				if (pathname === "/v3/transactions/908790/refund") {
					return flutterwaveOk({ id: 8612, amount_refunded: 500, status: "completed" });
				}
				return flutterwaveError("Not found", 404);
			});

			const result = await flutterwavePaymentProvider.refund(
				ctx,
				{
					paymentReference: "908790",
					refundRequestId: "refund-req-1",
					amount: 50000,
					currency: "KES",
				},
				credentials,
			);
			expect(result.providerRefundId).toBe("8612");
			expect(paths).toContain("/v3/transactions/908790/refund");
		});

		it("refuses to refund blind when the refund history is briefly unavailable", async () => {
			const paths: string[] = [];
			const ctx = makeMockRuntimeContext(async (url) => {
				const { pathname } = new URL(url);
				paths.push(pathname);
				if (pathname === "/v3/refunds") return flutterwaveError("Service unavailable", 503);
				return flutterwaveOk({ id: 8612, amount_refunded: 500, status: "completed" });
			});

			await expect(
				flutterwavePaymentProvider.refund(
					ctx,
					{
						paymentReference: "908790",
						refundRequestId: "refund-req-1",
						amount: 50000,
						currency: "KES",
					},
					credentials,
				),
			).rejects.toThrow(/Service unavailable/);
			expect(paths).not.toContain("/v3/transactions/908790/refund");
		});

		it("resolves a tx_ref to the numeric id before refunding", async () => {
			const paths: string[] = [];
			const ctx = makeMockRuntimeContext(async (url) => {
				const { pathname } = new URL(url);
				paths.push(pathname);
				if (pathname === "/v3/transactions/verify_by_reference") {
					return flutterwaveOk({ id: 908790, tx_ref: "dc-abc", status: "successful" });
				}
				if (pathname === "/v3/refunds") {
					return flutterwaveOk([], { page_info: { total_pages: 1 } });
				}
				if (pathname === "/v3/transactions/908790/refund") {
					return flutterwaveOk({ id: 8612, amount_refunded: 1500, status: "completed" });
				}
				return flutterwaveError("Not found", 404);
			});

			await flutterwavePaymentProvider.refund(
				ctx,
				{
					paymentReference: "dc-abc",
					refundRequestId: "refund-req-1",
					currency: "KES",
				},
				credentials,
			);
			expect(paths).toContain("/v3/transactions/verify_by_reference");
			expect(paths).toContain("/v3/transactions/908790/refund");
		});

		it("requires a usable refundRequestId and a payment reference", async () => {
			const ctx = makeMockRuntimeContext(async () => flutterwaveOk({}));
			await expect(
				flutterwavePaymentProvider.refund(
					ctx,
					{ paymentReference: "1", refundRequestId: "", currency: "KES" },
					credentials,
				),
			).rejects.toThrow(/non-empty refundRequestId/);
			await expect(
				flutterwavePaymentProvider.refund(
					ctx,
					{ paymentReference: "1", refundRequestId: "has space", currency: "KES" },
					credentials,
				),
			).rejects.toThrow(/without spaces or brackets/);
			await expect(
				flutterwavePaymentProvider.refund(
					ctx,
					{ paymentReference: "", refundRequestId: "ok", currency: "KES" },
					credentials,
				),
			).rejects.toThrow(/requires paymentReference/);
		});
	});

	describe("checkConnection", () => {
		it("reports test mode and a readable key", async () => {
			let requested = "";
			const ctx = makeMockRuntimeContext(async (url) => {
				requested = url;
				return flutterwaveOk({ NGN: 1000 });
			});
			const result = await flutterwavePaymentProvider.checkConnection?.(ctx, credentials);
			expect(requested).toBe("https://api.flutterwave.com/v3/balances");
			expect(result?.ok).toBe(true);
			expect(result?.mode).toBe("test");
		});

		it("reports live mode for a live key", async () => {
			const ctx = makeMockRuntimeContext(async () => flutterwaveOk({}));
			const result = await flutterwavePaymentProvider.checkConnection?.(ctx, {
				secretKey: "FLWSECK-1234567890abcdef-X",
			});
			expect(result?.mode).toBe("live");
		});

		it("reports a refused key instead of throwing", async () => {
			const ctx = makeMockRuntimeContext(async () =>
				flutterwaveError("Authorization required", 401),
			);
			const result = await flutterwavePaymentProvider.checkConnection?.(ctx, credentials);
			expect(result?.ok).toBe(false);
			expect(result?.message).toContain("refused the key");
		});
	});

	describe("formatAmount", () => {
		it("shows major units", () => {
			expect(flutterwavePaymentProvider.formatAmount(250000, "kes")).toBe("KES 2500.00");
		});
	});
});

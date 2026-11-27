/**
 * Event-level dedup records a provider's event id before the handler runs
 * and keeps it when the handler fails, so a retry is skipped. That trade-off
 * stays (a dropped event beats a duplicate side effect), with one exception:
 * when the provider's confirmation read fails, nothing has happened yet, so
 * the record is released and the provider's retry is processed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	createMockPaymentProvider,
	type PaymentProvider,
	type PaymentStatusResult,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { deliverWebhook, makeRouteContext, startCheckout } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const mockSettings = {
	"settings:paymentProvider": "mock",
	"settings:checkoutMode": "hosted",
	"settings:mockSecretKey": "mock-secret-key",
	"settings:mockWebhookSecret": "test-secret",
};

/** A mock provider whose live status check answers from a script. */
function scriptedProvider(script: Array<PaymentStatusResult | Error>): PaymentProvider {
	const base = createMockPaymentProvider({ id: "mock" });
	let call = 0;
	return {
		...base,
		async getPaymentStatus(_ctx, paymentReference) {
			const next = script[Math.min(call++, script.length - 1)];
			if (next instanceof Error) throw next;
			return { ...next, paymentReference };
		},
	};
}

function chargeSucceeded(orderDraftId: string): string {
	return JSON.stringify({
		id: "evt_retry_1",
		type: "charge.succeeded",
		orderDraftId,
		paymentReference: "pay_retry_1",
		amount: 150000,
		currency: "KES",
		email: "supporter@example.com",
	});
}

const headers = { "x-mock-signature": "signed" };
const paid: PaymentStatusResult = { status: "succeeded", amount: 150000, currency: "KES" };

describe("webhook retry after a failed confirmation", () => {
	it("processes the retry when the provider's status check threw", async () => {
		registerPaymentProvider(scriptedProvider([new Error("provider unavailable"), paid]), {
			override: true,
		});
		const { ctx, getCol } = makeRouteContext(mockSettings);
		const draftId = await startCheckout(ctx, "sess_retry_throw");
		const payload = chargeSucceeded(draftId);

		const first = await deliverWebhook(ctx, payload, headers);
		expect(first.status).toBeGreaterThanOrEqual(500);
		expect(getCol("orders").size).toBe(0);

		const retry = await deliverWebhook(ctx, payload, headers);
		expect(retry.status).toBe(200);
		expect(((await retry.json()) as { duplicate?: boolean }).duplicate).not.toBe(true);
		expect(getCol("orders").size).toBe(1);
	});

	it("processes the retry when the provider did not yet confirm payment", async () => {
		registerPaymentProvider(scriptedProvider([{ status: "pending" }, paid]), { override: true });
		const { ctx, getCol } = makeRouteContext(mockSettings);
		const draftId = await startCheckout(ctx, "sess_retry_pending");
		const payload = chargeSucceeded(draftId);

		const first = await deliverWebhook(ctx, payload, headers);
		expect(first.status).toBeGreaterThanOrEqual(500);

		const retry = await deliverWebhook(ctx, payload, headers);
		expect(retry.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});

	it("still skips an exact repeat once the event was processed", async () => {
		registerPaymentProvider(scriptedProvider([paid]), { override: true });
		const { ctx, getCol, logs } = makeRouteContext(mockSettings);
		const draftId = await startCheckout(ctx, "sess_repeat");
		const payload = chargeSucceeded(draftId);

		expect((await deliverWebhook(ctx, payload, headers)).status).toBe(200);
		const repeat = await deliverWebhook(ctx, payload, headers);
		expect(((await repeat.json()) as { duplicate?: boolean }).duplicate).toBe(true);
		expect(getCol("orders").size).toBe(1);
		// The log names the provider that sent the event, not Stripe.
		expect(logs).toContainEqual(
			expect.objectContaining({
				level: "info",
				msg: "Webhook deduped",
				meta: expect.objectContaining({ providerId: "mock", type: "charge.succeeded" }),
			}),
		);
	});

	it("keeps the record for failures other than confirmation, as before", async () => {
		registerPaymentProvider(scriptedProvider([paid]), { override: true });
		const { ctx, getCol } = makeRouteContext(mockSettings);
		// No checkout started: the draft snapshot is missing, a failure that
		// is not about confirming the payment.
		const payload = chargeSucceeded("0123456789abcdef0123456789abcdef");

		const first = await deliverWebhook(ctx, payload, headers);
		expect(first.status).toBe(500);
		const retry = await deliverWebhook(ctx, payload, headers);
		expect(((await retry.json()) as { duplicate?: boolean }).duplicate).toBe(true);
		expect(getCol("orders").size).toBe(0);
	});
});

describe("Stripe: retry after a failed PaymentIntent retrieve", () => {
	const whsec = "whsec_test_retry";

	async function stripeSignature(payload: string): Promise<string> {
		const t = Math.floor(Date.now() / 1000);
		const enc = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			enc.encode(whsec),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = new Uint8Array(
			await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)),
		);
		return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
	}

	it("processes Stripe's retry of checkout.session.completed", async () => {
		registerPaymentProvider(scriptedProvider([paid]), { override: true });
		let piCalls = 0;
		const { ctx, getCol } = makeRouteContext(
			{
				...mockSettings,
				"settings:stripeSecretKey": "sk_test_1234567890abcdef",
				"settings:stripeWebhookSecret": whsec,
			},
			async (url) => {
				if (!url.startsWith("https://api.stripe.com/v1/payment_intents/pi_retry")) {
					throw new Error(`Unexpected Stripe call: ${url}`);
				}
				piCalls++;
				if (piCalls === 1) {
					return new Response(JSON.stringify({ error: { message: "Service unavailable" } }), {
						status: 503,
					});
				}
				return new Response(
					JSON.stringify({
						id: "pi_retry",
						object: "payment_intent",
						amount: 150000,
						amount_received: 150000,
						currency: "kes",
						status: "succeeded",
						metadata: { orderDraftId: draftId },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);
		const draftId = await startCheckout(ctx, "sess_stripe_retry");
		const payload = JSON.stringify({
			id: "evt_stripe_retry",
			type: "checkout.session.completed",
			data: {
				object: {
					id: "cs_retry",
					object: "checkout.session",
					mode: "payment",
					payment_status: "paid",
					payment_intent: "pi_retry",
					amount_total: 150000,
					currency: "kes",
					metadata: { orderDraftId: draftId },
					customer_details: {
						email: "supporter@example.com",
						address: { line1: "Ngong Road", city: "Nairobi", country: "KE" },
					},
				},
			},
		});

		const first = await deliverWebhook(ctx, payload, {
			"stripe-signature": await stripeSignature(payload),
		});
		expect(first.status).toBeGreaterThanOrEqual(500);
		expect(getCol("orders").size).toBe(0);

		const retry = await deliverWebhook(ctx, payload, {
			"stripe-signature": await stripeSignature(payload),
		});
		expect(retry.status).toBe(200);
		expect(((await retry.json()) as { duplicate?: boolean }).duplicate).not.toBe(true);
		expect(getCol("orders").size).toBe(1);
	});
});

/**
 * What the package declares to core: its webhook headers, its
 * credential fields, and refund.* events as refund.updated.
 */

import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { paystackPaymentProvider } from "../src/provider";

const sk = "sk_test_1234567890abcdef";
const whsec = "whsec_1234567890abcdef";
const body = '{"event":"charge.success","data":{"id":1}}';

function bothHeaders(t = Math.floor(Date.now() / 1000)): Headers {
	const v1 = createHmac("sha512", whsec).update(`${t}.${body}`).digest("hex");
	const legacy = createHmac("sha512", sk).update(body).digest("hex");
	return new Headers({
		"Paystack-Signature": `t=${t},v1=whk_test:${v1}`,
		"x-paystack-signature": legacy,
	});
}

describe("declared to core", () => {
	it("claims both Paystack signature headers, the current one first", () => {
		expect(paystackPaymentProvider.webhookHeaders).toEqual([
			"paystack-signature",
			"x-paystack-signature",
		]);
	});

	it("accepts secret or restricted keys, and whsec_ or (legacy) sk_ webhook secrets", () => {
		const fields = paystackPaymentProvider.credentialFields;
		expect(fields?.secretKey?.prefixes).toEqual(["sk_test_", "sk_live_", "rk_test_", "rk_live_"]);
		expect(fields?.webhookSecret?.prefixes).toEqual(["whsec_", "sk_test_", "sk_live_"]);
	});
});

describe("verifyWebhook picks the header that matches the configured secret", () => {
	it("uses Paystack-Signature for a whsec_ secret", async () => {
		const headers = bothHeaders();
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body,
			signatureHeader: headers.get("x-paystack-signature") ?? "",
			secret: whsec,
			headers,
		});
		expect(result.ok).toBe(true);
	});

	it("uses x-paystack-signature for an sk_ secret", async () => {
		const headers = bothHeaders();
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body,
			signatureHeader: headers.get("paystack-signature") ?? "",
			secret: sk,
			headers,
		});
		expect(result.ok).toBe(true);
	});

	// What Paystack did in a real test-mode run: the account had a whsec_
	// secret, but each delivery carried only x-paystack-signature.
	const legacyOnly = (rawBody = body) =>
		new Headers({ "x-paystack-signature": createHmac("sha512", sk).update(rawBody).digest("hex") });

	it("verifies a legacy-only delivery with the saved sk_ secret key when the webhook secret is whsec_", async () => {
		const headers = legacyOnly();
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body,
			signatureHeader: headers.get("x-paystack-signature") ?? "",
			secret: whsec,
			headers,
			credentials: { secretKey: sk, webhookSecret: whsec },
		});
		expect(result.ok).toBe(true);
	});

	it("still refuses a tampered legacy-only delivery", async () => {
		const headers = legacyOnly();
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body.replace('"id":1', '"id":2'),
			signatureHeader: headers.get("x-paystack-signature") ?? "",
			secret: whsec,
			headers,
			credentials: { secretKey: sk, webhookSecret: whsec },
		});
		expect(result.ok).toBe(false);
	});

	it("explains the fix when a legacy-only delivery comes and no sk_ key is saved", async () => {
		const headers = legacyOnly();
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body,
			signatureHeader: headers.get("x-paystack-signature") ?? "",
			secret: whsec,
			headers,
			credentials: { secretKey: "rk_test_restricted", webhookSecret: whsec },
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("only x-paystack-signature");
		expect(result.reason).toContain("sk_ secret key");
	});

	it("does not fall back to the legacy header when Paystack-Signature fails", async () => {
		// A replay outside the 300-second window must not pass on the
		// window-less legacy header sent alongside it.
		const headers = bothHeaders(Math.floor(Date.now() / 1000) - 1000);
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body,
			signatureHeader: headers.get("paystack-signature") ?? "",
			secret: whsec,
			headers,
			credentials: { secretKey: sk, webhookSecret: whsec },
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("300-second window");
	});
});

describe("refund.* events", () => {
	const refundEvent = (event: string, data: Record<string, unknown>) =>
		JSON.stringify({ event, data: { transaction_reference: "dc-x", currency: "KES", ...data } });

	it("maps each documented refund event to refund.updated", () => {
		for (const [event, status] of [
			["refund.pending", "pending"],
			["refund.processing", "pending"],
			["refund.needs-attention", "pending"],
			["refund.processed", "succeeded"],
			["refund.failed", "failed"],
		] as const) {
			const parsed = paystackPaymentProvider.parseWebhookEvent(
				refundEvent(event, { id: 19224707 }),
			);
			expect(parsed).toMatchObject({
				type: "refund.updated",
				providerId: "paystack",
				providerEventId: `${event}:19224707`,
				providerRefundId: "19224707",
				paymentReference: "dc-x",
				status,
			});
		}
	});

	it("handles the shape real deliveries have: a string id and a null refund_reference", () => {
		const parsed = paystackPaymentProvider.parseWebhookEvent(
			refundEvent("refund.processed", {
				id: "19244346",
				status: "processed",
				refund_reference: null,
			}),
		);
		expect(parsed).toMatchObject({
			type: "refund.updated",
			providerEventId: "refund.processed:19244346",
			providerRefundId: "19244346",
			status: "succeeded",
		});
	});

	it("leaves a refund event without a refund id unhandled rather than guess", () => {
		const parsed = paystackPaymentProvider.parseWebhookEvent(
			refundEvent("refund.processed", { refund_reference: "01a1f190-36de-773b-a7b3-04eafa8597cd" }),
		);
		expect(parsed).toMatchObject({ type: "unhandled", providerEventType: "refund.processed" });
	});
});

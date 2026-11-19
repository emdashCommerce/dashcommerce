/**
 * What the package declares to core: its webhook headers, its
 * credential fields, and refund.* events as refund.updated.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
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

	it("still refuses a whsec_ secret when only the legacy header came", async () => {
		const headers = new Headers({
			"x-paystack-signature": bothHeaders().get("x-paystack-signature") ?? "",
		});
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body,
			signatureHeader: headers.get("x-paystack-signature") ?? "",
			secret: whsec,
			headers,
		});
		expect(result.ok).toBe(false);
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
				providerRefundId: "19224707",
				paymentReference: "dc-x",
				status,
			});
		}
	});

	it("leaves a refund event without a refund id unhandled rather than guess", () => {
		const parsed = paystackPaymentProvider.parseWebhookEvent(
			refundEvent("refund.processed", { refund_reference: "01a1f190-36de-773b-a7b3-04eafa8597cd" }),
		);
		expect(parsed).toMatchObject({ type: "unhandled", providerEventType: "refund.processed" });
	});
});

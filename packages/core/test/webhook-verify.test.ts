import { describe, expect, it } from "bun:test";
import {
	parseSignatureHeader,
	verifyStripeSignature,
} from "../src/stripe/webhook-verify";

/** Compute an HMAC-SHA256 hex digest over `data` with the given secret. */
async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(data),
	);
	const bytes = new Uint8Array(sig);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

describe("parseSignatureHeader", () => {
	it("returns timestamp + v1 signatures for a well-formed header", () => {
		const parsed = parseSignatureHeader(
			"t=1699999999,v1=aaa,v1=bbb,v0=cc",
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.timestamp).toBe(1699999999);
		expect(parsed?.v1Signatures).toEqual(["aaa", "bbb"]);
	});

	it("returns null for a header missing t or v1", () => {
		expect(parseSignatureHeader("v1=aaa")).toBeNull();
		expect(parseSignatureHeader("t=123")).toBeNull();
		expect(parseSignatureHeader("")).toBeNull();
	});
});

describe("verifyStripeSignature", () => {
	const secret = "whsec_test_secret_1234567890";
	const payload = JSON.stringify({ type: "payment_intent.succeeded", id: "evt_1" });

	it("accepts a signature computed the Stripe way", async () => {
		const now = 1_700_000_000_000; // fixed clock
		const timestamp = Math.floor(now / 1000);
		const expected = await hmacHex(secret, `${timestamp}.${payload}`);
		const header = `t=${timestamp},v1=${expected}`;
		const result = await verifyStripeSignature({
			payload,
			signatureHeader: header,
			secret,
			now,
		});
		expect(result.ok).toBe(true);
		expect(result.timestamp).toBe(timestamp);
	});

	it("rejects when the signature is wrong", async () => {
		const now = 1_700_000_000_000;
		const timestamp = Math.floor(now / 1000);
		const header = `t=${timestamp},v1=${"0".repeat(64)}`;
		const result = await verifyStripeSignature({
			payload,
			signatureHeader: header,
			secret,
			now,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("no matching");
	});

	it("rejects when the timestamp is outside tolerance", async () => {
		const timestamp = 1000; // far in the past
		const sig = await hmacHex(secret, `${timestamp}.${payload}`);
		const header = `t=${timestamp},v1=${sig}`;
		const now = (timestamp + 600) * 1000; // 10 minutes after
		const result = await verifyStripeSignature({
			payload,
			signatureHeader: header,
			secret,
			now,
			toleranceSeconds: 300,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("tolerance");
	});

	it("accepts when one of multiple v1 signatures matches", async () => {
		const now = 1_700_000_000_000;
		const timestamp = Math.floor(now / 1000);
		const correct = await hmacHex(secret, `${timestamp}.${payload}`);
		const header = `t=${timestamp},v1=${"0".repeat(64)},v1=${correct}`;
		const result = await verifyStripeSignature({
			payload,
			signatureHeader: header,
			secret,
			now,
		});
		expect(result.ok).toBe(true);
	});
});

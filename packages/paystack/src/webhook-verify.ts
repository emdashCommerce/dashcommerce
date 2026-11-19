/**
 * Paystack webhook signature verification — Web Crypto, sandbox-safe.
 *
 * Paystack signs the raw request body with HMAC-SHA512 keyed on the
 * merchant's SECRET key (not a separate webhook secret — Paystack has no
 * distinct webhook-signing secret the way Stripe does) and sends the hex
 * digest verbatim in the `x-paystack-signature` header.
 */

function hexToBytes(hex: string): Uint8Array {
	const clean = hex.trim();
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

async function hmacSha512Hex(secret: string, data: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-512" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
	const bytes = new Uint8Array(sig);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

export interface VerifyInput {
	payload: string;
	signatureHeader: string;
	secret: string;
}

export interface VerifyResult {
	ok: boolean;
	reason?: string;
}

export async function verifyPaystackSignature(input: VerifyInput): Promise<VerifyResult> {
	if (!input.signatureHeader || !input.signatureHeader.trim()) {
		return { ok: false, reason: "Missing x-paystack-signature header" };
	}
	if (!input.secret || !input.secret.trim()) {
		return { ok: false, reason: "Missing Paystack secret key for verification" };
	}

	const expectedHex = input.signatureHeader.trim().toLowerCase();
	if (!/^[0-9a-f]{128}$/i.test(expectedHex)) {
		return { ok: false, reason: "Malformed Paystack signature (expected 128-char SHA-512 hex)" };
	}

	let computedHex: string;
	try {
		computedHex = await hmacSha512Hex(input.secret, input.payload);
	} catch (err) {
		return { ok: false, reason: `Web Crypto HMAC error: ${(err as Error).message}` };
	}

	const expectedBytes = hexToBytes(expectedHex);
	const computedBytes = hexToBytes(computedHex);
	const matches = constantTimeEqualBytes(expectedBytes, computedBytes);

	if (!matches) {
		return { ok: false, reason: "Signature mismatch" };
	}

	return { ok: true };
}

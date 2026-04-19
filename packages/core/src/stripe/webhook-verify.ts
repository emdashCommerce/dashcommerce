/**
 * Stripe webhook signature verification — Web Crypto, sandbox-safe.
 *
 * Stripe signs webhook payloads with HMAC-SHA256. The `Stripe-Signature`
 * header has the form `t=<timestamp>,v1=<signature>[,v0=…]`. We:
 *
 *   1. Parse out timestamp + all `v1` signatures (key rotation allows
 *      multiple).
 *   2. Construct the signed payload: `${timestamp}.${rawBody}`.
 *   3. HMAC-SHA256 with the webhook secret via `crypto.subtle`.
 *   4. Constant-time compare against any provided `v1` value.
 *   5. Reject if more than `toleranceSeconds` from now (default 300).
 */

export interface VerifyInput {
	payload: string;
	signatureHeader: string;
	secret: string;
	now?: number; // ms since epoch, overrideable for tests
	toleranceSeconds?: number;
}

export interface VerifyResult {
	ok: boolean;
	reason?: string;
	timestamp?: number;
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
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

export interface ParsedSignatureHeader {
	timestamp: number;
	v1Signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
	if (!header) return null;
	const parts = header.split(",").map((p) => p.trim());
	let timestamp = 0;
	const v1: string[] = [];
	for (const part of parts) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq);
		const value = part.slice(eq + 1);
		if (key === "t") timestamp = Number.parseInt(value, 10);
		else if (key === "v1") v1.push(value);
	}
	if (!Number.isFinite(timestamp) || timestamp === 0 || v1.length === 0) return null;
	return { timestamp, v1Signatures: v1 };
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
	const bytes = new Uint8Array(sig);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

export async function verifyStripeSignature(input: VerifyInput): Promise<VerifyResult> {
	const parsed = parseSignatureHeader(input.signatureHeader);
	if (!parsed) return { ok: false, reason: "invalid Stripe-Signature header" };

	const now = input.now ?? Date.now();
	const tolerance = (input.toleranceSeconds ?? 300) * 1000;
	if (Math.abs(now - parsed.timestamp * 1000) > tolerance) {
		return { ok: false, reason: "timestamp outside tolerance", timestamp: parsed.timestamp };
	}

	const signedPayload = `${parsed.timestamp}.${input.payload}`;
	const expectedHex = await hmacSha256Hex(input.secret, signedPayload);
	const expected = hexToBytes(expectedHex);

	for (const v1 of parsed.v1Signatures) {
		if (constantTimeEqualBytes(hexToBytes(v1), expected)) {
			return { ok: true, timestamp: parsed.timestamp };
		}
	}
	return { ok: false, reason: "no matching v1 signature", timestamp: parsed.timestamp };
}

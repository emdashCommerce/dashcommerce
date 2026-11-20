/**
 * Paystack webhook signature verification. Web Crypto only, so it is
 * sandbox-safe.
 *
 * Paystack sends two signature schemes
 * (https://paystack.com/docs/v2/developer-tools/integration/webhooks):
 *
 * - `Paystack-Signature: t=<unix>,v1=<whk_ key id>:<hex>[,v1=…]`, the current
 *   scheme. Each `v1` is a lowercase-hex HMAC-SHA512 of `"<t>." + raw body`,
 *   keyed with the whole `whsec_` signing secret. There are two `v1` values
 *   while a secret is being rotated; any match is enough. `t` must be within
 *   300 seconds of the server clock, so a captured delivery cannot be
 *   replayed later.
 * - `x-paystack-signature: <hex>`, deprecated: an HMAC-SHA512 of the raw body
 *   keyed with the `sk_` secret key. No timestamp, so no replay window.
 *   Paystack stops sending it once the secret key is deleted.
 *
 * The scheme is chosen from the header value, so either header works with
 * whichever secret the merchant configured for it.
 */

/** Paystack's tolerance, in seconds, either side of the server clock. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const HEX_SHA512 = /^[0-9a-f]{128}$/;

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

async function hmacSha512(secret: string, data: string): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-512" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

export interface VerifyInput {
	payload: string;
	signatureHeader: string;
	secret: string;
	/** Override the clock in tests; Unix seconds. */
	nowSeconds?: number;
}

export interface VerifyResult {
	ok: boolean;
	reason?: string;
}

interface ParsedHeader {
	/** Exactly as sent: Paystack signs this string, not a re-serialised number. */
	rawTimestamp: string;
	timestamp: number;
	signatures: string[];
}

/** Parse `t=…,v1=…[,v1=…]`, ignoring fields Paystack may add later. */
function parseSignatureHeader(header: string): ParsedHeader | string {
	const timestamps: string[] = [];
	const signatures: string[] = [];
	for (const part of header.split(",")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (name === "t") timestamps.push(value);
		// `<whk_ key id>:<hex>`; the key id names the secret, the hex is the signature.
		if (name === "v1") signatures.push(value.slice(value.lastIndexOf(":") + 1).toLowerCase());
	}
	if (timestamps.length !== 1) return "Paystack-Signature must carry exactly one t";
	const raw = timestamps[0] ?? "";
	if (!/^\d+$/.test(raw)) return "Paystack-Signature has a malformed t";
	if (signatures.length === 0) return "Paystack-Signature carries no v1 signature";
	return { rawTimestamp: raw, timestamp: Number(raw), signatures };
}

async function verifyCurrentScheme(input: VerifyInput, header: string): Promise<VerifyResult> {
	const parsed = parseSignatureHeader(header);
	if (typeof parsed === "string") return { ok: false, reason: parsed };

	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (Math.abs(now - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
		return { ok: false, reason: "Paystack-Signature timestamp is outside the 300-second window" };
	}

	let computed: Uint8Array;
	try {
		computed = await hmacSha512(input.secret, `${parsed.rawTimestamp}.${input.payload}`);
	} catch (err) {
		return { ok: false, reason: `Web Crypto HMAC error: ${(err as Error).message}` };
	}

	// Check every candidate, without stopping at the first match.
	let matched = false;
	for (const candidate of parsed.signatures) {
		if (!HEX_SHA512.test(candidate)) continue;
		if (constantTimeEqualBytes(hexToBytes(candidate), computed)) matched = true;
	}
	if (matched) return { ok: true };

	if (!input.secret.startsWith("whsec_")) {
		return {
			ok: false,
			reason: "Signature mismatch: Paystack-Signature is keyed with the whsec_ signing secret",
		};
	}
	return { ok: false, reason: "Signature mismatch" };
}

async function verifyLegacyScheme(input: VerifyInput, header: string): Promise<VerifyResult> {
	const expectedHex = header.toLowerCase();
	if (!HEX_SHA512.test(expectedHex)) {
		return { ok: false, reason: "Malformed Paystack signature (expected 128-char SHA-512 hex)" };
	}

	let computed: Uint8Array;
	try {
		computed = await hmacSha512(input.secret, input.payload);
	} catch (err) {
		return { ok: false, reason: `Web Crypto HMAC error: ${(err as Error).message}` };
	}

	if (constantTimeEqualBytes(hexToBytes(expectedHex), computed)) return { ok: true };
	if (input.secret.startsWith("whsec_")) {
		return {
			ok: false,
			reason:
				"Signature mismatch: Paystack sent only x-paystack-signature, which is signed with your sk_ secret key; save that key as the Paystack key or the webhook secret",
		};
	}
	return { ok: false, reason: "Signature mismatch" };
}

export async function verifyPaystackSignature(input: VerifyInput): Promise<VerifyResult> {
	const header = input.signatureHeader?.trim() ?? "";
	if (!header) {
		return { ok: false, reason: "Missing Paystack-Signature or x-paystack-signature header" };
	}
	if (!input.secret || !input.secret.trim()) {
		return { ok: false, reason: "Missing Paystack webhook secret for verification" };
	}
	return /(^|,)\s*t=/.test(header)
		? verifyCurrentScheme(input, header)
		: verifyLegacyScheme(input, header);
}

/**
 * Signed self-service tokens for customer subscription management.
 *
 * Format: `{subscriptionId}.{expMs}.{sigHex}` — compact, URL-safe, no JSON.
 * HMAC-SHA256 over `"{subscriptionId}.{expMs}"` using a 32-byte secret
 * stored in KV under `state:subscriptionSigningSecret`.
 *
 * TTL defaults to 7 days. Emailed at subscription-creation time; also
 * regenerable from the customer's account page in the storefront.
 */

import type { PluginContext } from "emdash";

const SECRET_KEY = "state:subscriptionSigningSecret";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function bytesToHex(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
	const out = new ArrayBuffer(hex.length / 2);
	const view = new Uint8Array(out);
	for (let i = 0; i < view.length; i += 1) {
		view[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function hexToBytes(hex: string): Uint8Array {
	return new Uint8Array(hexToArrayBuffer(hex));
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

async function getOrCreateSecret(ctx: PluginContext): Promise<string> {
	const existing = await ctx.kv.get<string>(SECRET_KEY);
	if (existing) return existing;
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	await ctx.kv.set(SECRET_KEY, hex);
	return hex;
}

async function hmacHex(secretHex: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		hexToArrayBuffer(secretHex),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	// Clone the encoded bytes into a freshly-allocated ArrayBuffer so the
	// WebCrypto signature never sees a `SharedArrayBuffer`-typed view.
	const encoded = new TextEncoder().encode(data);
	const dataBuf = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(dataBuf).set(encoded);
	const sig = await crypto.subtle.sign("HMAC", key, dataBuf);
	return bytesToHex(sig);
}

export interface IssueInput {
	subscriptionId: string;
	ttlMs?: number;
}

export async function issueToken(ctx: PluginContext, input: IssueInput): Promise<string> {
	const secret = await getOrCreateSecret(ctx);
	const exp = Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS);
	const body = `${input.subscriptionId}.${exp}`;
	const sig = await hmacHex(secret, body);
	return `${body}.${sig}`;
}

export interface VerifyResult {
	ok: boolean;
	subscriptionId?: string;
	reason?: string;
}

export async function verifyToken(ctx: PluginContext, token: string): Promise<VerifyResult> {
	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, reason: "malformed token" };
	const [subscriptionId, expStr, sig] = parts as [string, string, string];
	const exp = Number.parseInt(expStr, 10);
	if (!Number.isFinite(exp)) return { ok: false, reason: "bad exp" };
	if (Date.now() > exp) return { ok: false, reason: "expired" };

	const secret = await ctx.kv.get<string>(SECRET_KEY);
	if (!secret) return { ok: false, reason: "no signing secret configured" };
	const expectedHex = await hmacHex(secret, `${subscriptionId}.${expStr}`);
	if (!constantTimeEqualBytes(hexToBytes(expectedHex), hexToBytes(sig))) {
		return { ok: false, reason: "signature mismatch" };
	}
	return { ok: true, subscriptionId };
}

/**
 * Signed download URLs — Web Crypto HMAC-SHA256.
 *
 * Token format: `${grantId}.${fileIndex}.${expMs}.${sigHex}`
 * HMAC over `${grantId}.${fileIndex}.${expMs}`.
 *
 * A 32-byte signing secret lives in KV at `state:downloadSigningSecret`,
 * provisioned once on install (phase 17). The token is emailed with the
 * order receipt and can be re-issued from the customer account page.
 *
 * TTL defaults from settings:
 *   `settings:downloadTokenTtlHours` (default 24)
 * Max-uses per grant from:
 *   `settings:downloadMaxUses` (default 3)
 */

import type { PluginContext } from "emdash";

const SECRET_KEY = "state:downloadSigningSecret";
const DEFAULT_TTL_HOURS = 24;
export const DEFAULT_MAX_USES = 3;

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

/** Read the current signing secret, creating it on first use. */
export async function getOrCreateSigningSecret(ctx: PluginContext): Promise<string> {
	const existing = await ctx.kv.get<string>(SECRET_KEY);
	if (existing) return existing;
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	await ctx.kv.set(SECRET_KEY, hex);
	return hex;
}

async function readTtlHours(ctx: PluginContext): Promise<number> {
	return (await ctx.kv.get<number>("settings:downloadTokenTtlHours")) ?? DEFAULT_TTL_HOURS;
}

async function hmacHex(secretHex: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		hexToArrayBuffer(secretHex),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const encoded = new TextEncoder().encode(data);
	const dataBuf = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(dataBuf).set(encoded);
	const sig = await crypto.subtle.sign("HMAC", key, dataBuf);
	return bytesToHex(sig);
}

export interface IssueTokenInput {
	grantId: string;
	fileIndex: number;
	ttlMs?: number;
}

export async function issueDownloadToken(
	ctx: PluginContext,
	input: IssueTokenInput,
): Promise<string> {
	const secret = await getOrCreateSigningSecret(ctx);
	const ttlMs = input.ttlMs ?? (await readTtlHours(ctx)) * 3_600_000;
	const exp = Date.now() + ttlMs;
	const body = `${input.grantId}.${input.fileIndex}.${exp}`;
	const sig = await hmacHex(secret, body);
	return `${body}.${sig}`;
}

export interface VerifyTokenResult {
	ok: boolean;
	reason?: string;
	grantId?: string;
	fileIndex?: number;
	expiresAt?: number;
}

export async function verifyDownloadToken(
	ctx: PluginContext,
	token: string,
): Promise<VerifyTokenResult> {
	const parts = token.split(".");
	if (parts.length !== 4) return { ok: false, reason: "malformed token" };
	const [grantId, fileIndexStr, expStr, sig] = parts as [string, string, string, string];

	const fileIndex = Number.parseInt(fileIndexStr, 10);
	const exp = Number.parseInt(expStr, 10);
	if (!Number.isFinite(fileIndex) || fileIndex < 0) return { ok: false, reason: "bad fileIndex" };
	if (!Number.isFinite(exp)) return { ok: false, reason: "bad exp" };
	if (Date.now() > exp) return { ok: false, reason: "expired" };

	const secret = await ctx.kv.get<string>(SECRET_KEY);
	if (!secret) return { ok: false, reason: "signing secret unavailable" };
	const expectedHex = await hmacHex(secret, `${grantId}.${fileIndexStr}.${expStr}`);
	if (!constantTimeEqualBytes(hexToBytes(expectedHex), hexToBytes(sig))) {
		return { ok: false, reason: "signature mismatch" };
	}
	return { ok: true, grantId, fileIndex, expiresAt: exp };
}

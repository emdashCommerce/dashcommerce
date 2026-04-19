/**
 * Abandoned-cart recovery.
 *
 *   Hourly cron → scan `cart:*` keys in KV → email anyone whose cart is
 *   past the abandoned-cart threshold and has an email → record the send
 *   so we don't keep nagging.
 *
 * Restore link format (same compact HMAC-SHA256 style as subscription /
 * download tokens): `{sessionId}.{expMs}.{sigHex}`
 * Lands at GET /cart/restore?token={token} → we rewrite the sid cookie and
 * respond 200 with the restored cart payload (or redirect at the astro
 * layer).
 *
 * Settings:
 *   settings:abandonedCartDelayHours   default 4
 *   settings:abandonedCartTokenTtlDays default 7
 */

import type { PluginContext } from "emdash";
import { save } from "../cart/store";
import { composeAbandonedCart } from "../emails";
import type { CartState } from "../types";

const SECRET_KEY = "state:cartRestoreSigningSecret";
const DEFAULT_DELAY_HOURS = 4;
const DEFAULT_TTL_DAYS = 7;

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

async function getSecret(ctx: PluginContext): Promise<string> {
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
	const encoded = new TextEncoder().encode(data);
	const buf = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(buf).set(encoded);
	const sig = await crypto.subtle.sign("HMAC", key, buf);
	return bytesToHex(sig);
}

export async function issueRestoreToken(
	ctx: PluginContext,
	sessionId: string,
): Promise<string> {
	const secret = await getSecret(ctx);
	const ttlDays =
		(await ctx.kv.get<number>("settings:abandonedCartTokenTtlDays")) ?? DEFAULT_TTL_DAYS;
	const exp = Date.now() + ttlDays * 86_400_000;
	const body = `${sessionId}.${exp}`;
	const sig = await hmacHex(secret, body);
	return `${body}.${sig}`;
}

export interface VerifyRestoreResult {
	ok: boolean;
	reason?: string;
	sessionId?: string;
}

export async function verifyRestoreToken(
	ctx: PluginContext,
	token: string,
): Promise<VerifyRestoreResult> {
	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, reason: "malformed token" };
	const [sessionId, expStr, sig] = parts as [string, string, string];
	const exp = Number.parseInt(expStr, 10);
	if (!Number.isFinite(exp)) return { ok: false, reason: "bad exp" };
	if (Date.now() > exp) return { ok: false, reason: "expired" };
	const secret = await ctx.kv.get<string>(SECRET_KEY);
	if (!secret) return { ok: false, reason: "signing secret unavailable" };
	const expected = await hmacHex(secret, `${sessionId}.${expStr}`);
	if (!constantTimeEqualBytes(hexToBytes(expected), hexToBytes(sig))) {
		return { ok: false, reason: "signature mismatch" };
	}
	return { ok: true, sessionId };
}

export interface RecoverResult {
	sent: number;
	scanned: number;
}

export async function recoverAbandoned(ctx: PluginContext): Promise<RecoverResult> {
	const delayHours =
		(await ctx.kv.get<number>("settings:abandonedCartDelayHours")) ?? DEFAULT_DELAY_HOURS;
	const staleThreshold = Date.now() - delayHours * 3_600_000;
	const rows = await ctx.kv.list("cart:");
	let sent = 0;
	for (const row of rows) {
		const cart = row.value as CartState | null;
		if (!cart) continue;
		if (!cart.customerEmail || !cart.customerEmail.includes("@")) continue;
		if (cart.items.length === 0) continue;
		if (cart.abandonedEmailSentAt) continue;
		if (Date.parse(cart.updatedAt) > staleThreshold) continue;

		const token = await issueRestoreToken(ctx, cart.sessionId);
		const restoreUrl = ctx.url(
			`/_emdash/api/plugins/${ctx.plugin.id}/cart/restore?token=${encodeURIComponent(token)}`,
		);
		const { subject, text, html } = composeAbandonedCart({
			cart,
			restoreUrl,
			siteName: ctx.site.name,
		});

		try {
			if (ctx.email) {
				await ctx.email.send({
					to: cart.customerEmail,
					subject,
					text,
					html,
				});
				await save(ctx, { ...cart, abandonedEmailSentAt: new Date().toISOString() });
				sent += 1;
			}
		} catch (err) {
			ctx.log.warn("Abandoned-cart email send failed", {
				sessionId: cart.sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { sent, scanned: rows.length };
}

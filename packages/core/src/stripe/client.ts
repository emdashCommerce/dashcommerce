/**
 * Stripe API client — sandbox-safe.
 *
 *   - Uses `ctx.http.fetch` (not global fetch) to honor `allowedHosts`.
 *   - Bodies are `application/x-www-form-urlencoded` per Stripe REST.
 *   - `Idempotency-Key` header on writes (callers pass a stable key).
 *   - Auto-injects `Authorization: Bearer {secretKey}`.
 *   - Throws `StripeApiError` on non-2xx with Stripe's error payload.
 */

import type { HttpAccess, PluginContext } from "emdash";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

export interface StripeClientOptions {
	secretKey: string;
	/** `acct_xxx` — for Connect direct-charge mode (Stripe-Account header). */
	stripeAccount?: string;
	/** Override for tests. */
	apiBase?: string;
}

export class StripeApiError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;
	constructor(status: number, body: Record<string, unknown>, message: string) {
		super(message);
		this.name = "StripeApiError";
		this.status = status;
		this.body = body;
	}
}

export interface StripeResponse<T> {
	data: T;
}

type StripeParamValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| StripeParamValue[]
	| { [k: string]: StripeParamValue };

export function encodeStripeForm(params: Record<string, StripeParamValue>): string {
	const pairs: string[] = [];
	const push = (key: string, value: StripeParamValue) => {
		if (value === null || value === undefined) return;
		if (Array.isArray(value)) {
			value.forEach((v, i) => push(`${key}[${i}]`, v));
			return;
		}
		if (typeof value === "object") {
			for (const [k, v] of Object.entries(value)) push(`${key}[${k}]`, v);
			return;
		}
		pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
	};
	for (const [k, v] of Object.entries(params)) push(k, v);
	return pairs.join("&");
}

function getHttp(ctx: PluginContext): HttpAccess {
	if (!ctx.http) throw new Error("ctx.http unavailable — declare network:fetch capability");
	return ctx.http;
}

export interface CallOptions {
	method?: "GET" | "POST" | "DELETE";
	path: string; // leading slash, e.g. /payment_intents
	params?: Record<string, StripeParamValue>;
	idempotencyKey?: string;
	client: StripeClientOptions;
}

export async function call<T = Record<string, unknown>>(
	ctx: PluginContext,
	opts: CallOptions,
): Promise<T> {
	const method = opts.method ?? "POST";
	const base = opts.client.apiBase ?? STRIPE_API_BASE;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.client.secretKey}`,
	};
	if (opts.client.stripeAccount) headers["Stripe-Account"] = opts.client.stripeAccount;
	if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

	let url = `${base}${opts.path}`;
	let body: string | undefined;
	if (method === "GET" && opts.params) {
		const qs = encodeStripeForm(opts.params);
		url = qs ? `${url}?${qs}` : url;
	} else if (opts.params) {
		body = encodeStripeForm(opts.params);
		headers["Content-Type"] = "application/x-www-form-urlencoded";
	}

	const res = await getHttp(ctx).fetch(url, { method, headers, body });
	const text = await res.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		throw new StripeApiError(res.status, { raw: text }, `Non-JSON Stripe response (${res.status})`);
	}
	if (!res.ok) {
		const err = (parsed.error ?? {}) as Record<string, unknown>;
		throw new StripeApiError(
			res.status,
			parsed,
			(err.message as string) ?? `Stripe ${res.status}`,
		);
	}
	return parsed as T;
}

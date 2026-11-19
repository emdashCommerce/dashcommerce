/**
 * Paystack API client — sandbox-safe, mirrors the calling convention
 * established by @dashcommerce/core:
 *
 *   - Uses the runtime context's `http.fetch` (not global fetch) so
 *     `allowedHosts` is honoured when this runs inside an EmDash sandbox.
 *   - JSON request/response bodies (Paystack REST API).
 *   - Auto-injects `Authorization: Bearer {secretKey}`.
 *   - Throws `PaystackApiError` on a non-2xx or a body with `status: false`.
 */

import type { PaymentProviderRuntimeContext } from "@dashcommerce/core/payment-provider";

export const PAYSTACK_API_BASE = "https://api.paystack.co";

export class PaystackApiError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;
	constructor(status: number, body: Record<string, unknown>, message: string) {
		super(message);
		this.name = "PaystackApiError";
		this.status = status;
		this.body = body;
	}
}

export interface PaystackClientOptions {
	secretKey: string;
	/** Override for tests. */
	apiBase?: string;
}

export interface PaystackCallOptions {
	method?: "GET" | "POST";
	path: string; // leading slash, e.g. /transaction/initialize
	body?: Record<string, unknown>;
	client: PaystackClientOptions;
}

export interface PaystackResponse<T> {
	status: boolean;
	message: string;
	data: T;
}

export async function call<T = Record<string, unknown>>(
	ctx: PaymentProviderRuntimeContext,
	opts: PaystackCallOptions,
): Promise<T> {
	const method = opts.method ?? "POST";
	const base = opts.client.apiBase ?? PAYSTACK_API_BASE;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.client.secretKey}`,
		"Content-Type": "application/json",
	};

	const fetchFn = ctx.http?.fetch ?? fetch;
	const res = await fetchFn(`${base}${opts.path}`, {
		method,
		headers,
		...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
	});

	const rawText = await res.text();
	let parsed: PaystackResponse<T>;
	try {
		parsed = JSON.parse(rawText) as PaystackResponse<T>;
	} catch {
		throw new PaystackApiError(
			res.status,
			{ raw: rawText },
			`Paystack returned unparseable response (${res.status})`,
		);
	}

	if (!res.ok || !parsed.status) {
		const msg =
			parsed.message ||
			(typeof parsed.data === "string" ? parsed.data : undefined) ||
			`Paystack API error (${res.status})`;
		throw new PaystackApiError(res.status, parsed as unknown as Record<string, unknown>, msg);
	}

	return parsed.data;
}

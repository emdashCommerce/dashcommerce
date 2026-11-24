/**
 * Flutterwave API client — sandbox-safe, mirrors the calling convention
 * established by @dashcommerce/core:
 *
 *   - Uses the runtime context's `http.fetch` (not global fetch) so
 *     `allowedHosts` is honoured when this runs inside an EmDash sandbox.
 *   - JSON request/response bodies (Flutterwave REST API v3).
 *   - Auto-injects `Authorization: Bearer {secretKey}`.
 *   - Throws `FlutterwaveApiError` on a non-2xx or a body whose
 *     `status` is not `"success"`.
 */

import type { PaymentProviderRuntimeContext } from "@dashcommerce/core/payment-provider";

export const FLUTTERWAVE_API_BASE = "https://api.flutterwave.com/v3";

export class FlutterwaveApiError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;
	constructor(status: number, body: Record<string, unknown>, message: string) {
		super(message);
		this.name = "FlutterwaveApiError";
		this.status = status;
		this.body = body;
	}
}

export interface FlutterwaveClientOptions {
	secretKey: string;
	/** Override for tests. */
	apiBase?: string;
}

export interface FlutterwaveCallOptions {
	method?: "GET" | "POST";
	path: string; // leading slash, e.g. /payments
	body?: Record<string, unknown>;
	client: FlutterwaveClientOptions;
}

export interface FlutterwavePageInfo {
	total?: number;
	current_page?: number;
	total_pages?: number;
	page_size?: number;
}

export interface FlutterwaveResponse<T> {
	status: "success" | "error";
	message: string;
	data: T;
	meta?: { page_info?: FlutterwavePageInfo };
}

export async function call<T = Record<string, unknown>>(
	ctx: PaymentProviderRuntimeContext,
	opts: FlutterwaveCallOptions,
): Promise<T> {
	return (await callEnvelope<T>(ctx, opts)).data;
}

/** As `call`, but returns the whole response, including list `meta`. */
export async function callEnvelope<T = Record<string, unknown>>(
	ctx: PaymentProviderRuntimeContext,
	opts: FlutterwaveCallOptions,
): Promise<FlutterwaveResponse<T>> {
	const method = opts.method ?? "POST";
	const base = opts.client.apiBase ?? FLUTTERWAVE_API_BASE;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.client.secretKey}`,
		"Content-Type": "application/json",
	};

	// Only the runtime's fetch, which enforces the plugin's allowedHosts.
	// Never fall back to global fetch: that would bypass the sandbox.
	if (!ctx.http?.fetch) {
		throw new Error("Flutterwave provider needs ctx.http.fetch (network:request capability)");
	}
	const res = await ctx.http.fetch(`${base}${opts.path}`, {
		method,
		headers,
		...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
	});

	const rawText = await res.text();
	let parsed: FlutterwaveResponse<T>;
	try {
		parsed = JSON.parse(rawText) as FlutterwaveResponse<T>;
	} catch {
		throw new FlutterwaveApiError(
			res.status,
			{ raw: rawText },
			`Flutterwave returned unparseable response (${res.status})`,
		);
	}

	if (!res.ok || parsed.status !== "success") {
		const msg =
			parsed.message ||
			(typeof parsed.data === "string" ? parsed.data : undefined) ||
			`Flutterwave API error (${res.status})`;
		throw new FlutterwaveApiError(res.status, parsed as unknown as Record<string, unknown>, msg);
	}

	return parsed;
}

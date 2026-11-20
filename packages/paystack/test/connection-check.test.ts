/**
 * "Test Paystack connection" in Settings: one read-only verify of a
 * reference that can't exist, read as accepted, refused or unexpected.
 */

import { describe, expect, it } from "bun:test";
import type { PaymentProviderRuntimeContext } from "@dashcommerce/core/payment-provider";
import { paystackPaymentProvider } from "../src/provider";

function answering(status: number, body: Record<string, unknown>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const ctx: PaymentProviderRuntimeContext = {
		http: {
			fetch: async (url, init) => {
				calls.push({ url, init });
				return new Response(JSON.stringify(body), { status });
			},
		},
		log: { info() {}, warn() {}, error() {} },
	};
	return { ctx, calls };
}

const NOT_FOUND = {
	status: false,
	message: "Transaction reference not found.",
	type: "validation_error",
	code: "transaction_not_found",
};

function check(ctx: PaymentProviderRuntimeContext, secretKey: string) {
	const fn = paystackPaymentProvider.checkConnection;
	if (!fn) throw new Error("checkConnection missing");
	return fn(ctx, { secretKey });
}

describe("Paystack connection check", () => {
	it("makes one GET verify with the key and nothing else", async () => {
		const { ctx, calls } = answering(400, NOT_FOUND);
		await check(ctx, "rk_test_1234567890abcdef");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://api.paystack.co/transaction/verify/dashcommerce-connection-check",
		);
		expect(calls[0]?.init?.method).toBe("GET");
		expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer rk_test_1234567890abcdef",
		);
	});

	it("reads 'reference not found' as connected, with the key's mode", async () => {
		expect(await check(answering(400, NOT_FOUND).ctx, "sk_test_1234567890abcdef")).toEqual({
			ok: true,
			mode: "test",
			message: "Connected in test mode. The key can read transactions.",
		});
		expect(await check(answering(400, NOT_FOUND).ctx, "rk_live_1234567890abcdef")).toEqual({
			ok: true,
			mode: "live",
			message: "Connected in live mode. The key can read transactions.",
		});
	});

	it("passes on Paystack's reason when it refuses the key", async () => {
		const refused = answering(401, { status: false, message: "Invalid key" });
		expect(await check(refused.ctx, "sk_test_1234567890abcdef")).toEqual({
			ok: false,
			mode: "test",
			message: "Paystack refused the key: Invalid key",
		});
		const forbidden = answering(403, {
			status: false,
			message: "This key does not have permission to perform this action",
		});
		expect((await check(forbidden.ctx, "rk_test_1234567890abcdef")).message).toBe(
			"Paystack refused the key: This key does not have permission to perform this action",
		);
	});

	it("reports any other answer as not connected", async () => {
		const down = answering(503, { status: false, message: "Service unavailable" });
		expect(await check(down.ctx, "sk_test_1234567890abcdef")).toEqual({
			ok: false,
			mode: "test",
			message: "Paystack answered 503: Service unavailable",
		});
	});

	it("lets a network failure through for core to report", async () => {
		const ctx: PaymentProviderRuntimeContext = {
			http: {
				fetch: async () => {
					throw new TypeError("fetch failed");
				},
			},
			log: { info() {}, warn() {}, error() {} },
		};
		await expect(check(ctx, "sk_test_1234567890abcdef")).rejects.toThrow("fetch failed");
	});
});

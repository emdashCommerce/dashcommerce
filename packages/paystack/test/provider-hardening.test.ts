/**
 * Double-refund guard, transaction-status mapping and `Paystack-Signature`
 * verification.
 *
 * The refund and verify fixtures are real Paystack test-mode responses
 * (sanitised) from 19 Nov 2026: transaction T877626421263494 (id 6480092473)
 * with two identical partial refunds, 19224707 (processed) and 19224741
 * (processing). Paystack accepted the second as a fresh refund, which is why
 * the guard exists.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import type { PaymentProviderRuntimeContext } from "@dashcommerce/core/payment-provider";
import { paystackPaymentProvider } from "../src/provider";
import { verifyPaystackSignature } from "../src/webhook-verify";
import refundList from "./fixtures/refund-list-by-transaction.json";
import verifyReversalPending from "./fixtures/verify-reversal-pending.json";

const credentials = { secretKey: "sk_test_1234567890abcdef" };

interface Recorded {
	method: string;
	url: string;
	body?: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** A fake Paystack that answers by method and path, and records each call. */
function fakePaystack(routes: Record<string, (url: URL) => Response>): {
	ctx: PaymentProviderRuntimeContext;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const ctx: PaymentProviderRuntimeContext = {
		http: {
			fetch: async (url, init) => {
				const method = init?.method ?? "GET";
				const parsed = new URL(url);
				calls.push({
					method,
					url,
					...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
				});
				const handler = routes[`${method} ${parsed.pathname}`];
				if (!handler) throw new Error(`Unexpected Paystack call: ${method} ${url}`);
				return handler(parsed);
			},
		},
		log: { info() {}, warn() {}, error() {} },
	};
	return { ctx, calls };
}

const emptyRefundList = {
	status: true,
	message: "Refunds retrieved",
	data: [],
	meta: { total: 0, skipped: 0, perPage: 100, page: 1, pageCount: 0 },
};

const createdRefund = {
	status: true,
	message: "Refund has been queued for processing",
	data: {
		id: 19300001,
		status: "pending",
		amount: 10000,
		currency: "KES",
		merchant_note: "(refundRequestId=refund:order1:abc)",
	},
};

describe("refund: double-refund guard", () => {
	it("returns the refund already carrying this refundRequestId instead of creating another", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/T877626421263494": () => json(verifyReversalPending),
			"GET /refund": () => json(refundList),
		});

		const result = await paystackPaymentProvider.refund(
			ctx,
			{
				refundRequestId: "fik57-test-1",
				paymentReference: "T877626421263494",
				amount: 10000,
				currency: "KES",
			},
			credentials,
		);

		expect(calls.some((c) => c.method === "POST")).toBe(false);
		// The first refund made for this request, not the accidental duplicate.
		expect(result.providerRefundId).toBe("19224707");
		expect(result.status).toBe("succeeded");
		expect(result.amount).toBe(10000);
		expect(result.currency).toBe("KES");
		expect(result.refundRequestId).toBe("fik57-test-1");
	});

	it("lists refunds by the numeric transaction id, never the reference", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/T877626421263494": () => json(verifyReversalPending),
			"GET /refund": () => json(refundList),
		});

		await paystackPaymentProvider.refund(
			ctx,
			{
				refundRequestId: "fik57-test-1",
				paymentReference: "T877626421263494",
				amount: 10000,
				currency: "KES",
			},
			credentials,
		);

		const list = calls.find((c) => c.method === "GET" && new URL(c.url).pathname === "/refund");
		expect(list).toBeDefined();
		expect(new URL(list?.url ?? "").searchParams.get("transaction")).toBe("6480092473");
	});

	it("creates a refund when none carries this refundRequestId", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/T877626421263494": () => json(verifyReversalPending),
			"GET /refund": () => json(refundList),
			"POST /refund": () => json(createdRefund),
		});

		const result = await paystackPaymentProvider.refund(
			ctx,
			{
				refundRequestId: "refund:order1:abc",
				paymentReference: "T877626421263494",
				amount: 10000,
				currency: "KES",
			},
			credentials,
		);

		const post = calls.find((c) => c.method === "POST");
		expect(post?.body?.transaction).toBe("T877626421263494");
		expect(post?.body?.amount).toBe(10000);
		expect(result.providerRefundId).toBe("19300001");
		expect(result.status).toBe("pending");
	});

	it("does not match a request id that merely starts with this one", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/T877626421263494": () => json(verifyReversalPending),
			"GET /refund": () => json(refundList),
			"POST /refund": () => json(createdRefund),
		});

		await paystackPaymentProvider.refund(
			ctx,
			{
				refundRequestId: "fik57-test",
				paymentReference: "T877626421263494",
				amount: 10000,
				currency: "KES",
			},
			credentials,
		);

		expect(calls.some((c) => c.method === "POST")).toBe(true);
	});

	it("ignores a failed refund with the same request id and tries again", async () => {
		const failedOnly = {
			...refundList,
			data: [{ ...refundList.data[1], status: "failed", reason: "FAILED" }],
		};
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/T877626421263494": () => json(verifyReversalPending),
			"GET /refund": () => json(failedOnly),
			"POST /refund": () => json(createdRefund),
		});

		await paystackPaymentProvider.refund(
			ctx,
			{
				refundRequestId: "fik57-test-1",
				paymentReference: "T877626421263494",
				amount: 10000,
				currency: "KES",
			},
			credentials,
		);

		expect(calls.some((c) => c.method === "POST")).toBe(true);
	});

	it("reads every page of refunds before deciding", async () => {
		const page1 = {
			...emptyRefundList,
			data: [{ ...refundList.data[0], merchant_note: "refundRequestId=someone-else" }],
			meta: { ...emptyRefundList.meta, total: 2, pageCount: 2 },
		};
		const page2 = {
			...emptyRefundList,
			data: [refundList.data[1]],
			meta: { ...emptyRefundList.meta, total: 2, page: 2, pageCount: 2 },
		};
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/T877626421263494": () => json(verifyReversalPending),
			"GET /refund": (url) => json(url.searchParams.get("page") === "2" ? page2 : page1),
		});

		const result = await paystackPaymentProvider.refund(
			ctx,
			{
				refundRequestId: "fik57-test-1",
				paymentReference: "T877626421263494",
				amount: 10000,
				currency: "KES",
			},
			credentials,
		);

		expect(calls.some((c) => c.method === "POST")).toBe(false);
		expect(result.providerRefundId).toBe("19224707");
	});

	it("writes the request id into merchant_note in the form the guard reads back", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/dc-x": () =>
				json({ ...verifyReversalPending, data: { ...verifyReversalPending.data, id: 42 } }),
			"GET /refund": () => json(emptyRefundList),
			"POST /refund": () => json(createdRefund),
		});

		await paystackPaymentProvider.refund(
			ctx,
			{
				refundRequestId: "refund:order1:abc",
				paymentReference: "dc-x",
				amount: 10000,
				currency: "KES",
				reason: "Event cancelled",
			},
			credentials,
		);

		const post = calls.find((c) => c.method === "POST");
		expect(post?.body?.merchant_note).toBe("Event cancelled (refundRequestId=refund:order1:abc)");
	});

	it("cannot be fooled by a tag inside the reason", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/dc-x": () => json(verifyReversalPending),
			"GET /refund": () =>
				json({
					...refundList,
					data: [
						{
							...refundList.data[1],
							merchant_note: "Event cancelled (refundRequestId=real-1)",
						},
					],
				}),
			"POST /refund": () => json(createdRefund),
		});

		await paystackPaymentProvider.refund(
			ctx,
			{
				refundRequestId: "other-2",
				paymentReference: "dc-x",
				amount: 10000,
				currency: "KES",
				reason: "dup (refundRequestId=real-1)",
			},
			credentials,
		);

		const post = calls.find((c) => c.method === "POST");
		// The brackets are stripped, so the note ends with our tag and no other.
		expect(post?.body?.merchant_note).toBe("dup refundRequestId=real-1 (refundRequestId=other-2)");
	});

	it("matches only the tag at the end of the note", async () => {
		const spoofed = {
			...refundList,
			data: [
				{
					...refundList.data[1],
					merchant_note: "(refundRequestId=target) (refundRequestId=someone-else)",
				},
			],
		};
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/dc-x": () => json(verifyReversalPending),
			"GET /refund": () => json(spoofed),
			"POST /refund": () => json(createdRefund),
		});

		await paystackPaymentProvider.refund(
			ctx,
			{ refundRequestId: "target", paymentReference: "dc-x", amount: 10000, currency: "KES" },
			credentials,
		);

		expect(calls.some((c) => c.method === "POST")).toBe(true);
	});

	it("refuses a request id the merchant note cannot hold unambiguously", async () => {
		const { ctx } = fakePaystack({});
		await expect(
			paystackPaymentProvider.refund(
				ctx,
				{
					refundRequestId: "has space",
					paymentReference: "dc-x",
					amount: 100,
					currency: "KES",
				},
				credentials,
			),
		).rejects.toThrow(/refundRequestId/);
	});

	it("does not create a refund when the lookup fails", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/dc-x": () =>
				json({ status: false, message: "Transaction reference not found" }, 400),
		});

		await expect(
			paystackPaymentProvider.refund(
				ctx,
				{ refundRequestId: "r1", paymentReference: "dc-x", amount: 100, currency: "KES" },
				credentials,
			),
		).rejects.toThrow(/not found/);
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("maps each documented refund status", async () => {
		for (const [paystackStatus, expected] of [
			["pending", "pending"],
			["processing", "pending"],
			["needs-attention", "pending"],
			["processed", "succeeded"],
			["failed", "failed"],
		] as const) {
			const { ctx } = fakePaystack({
				"GET /transaction/verify/dc-x": () => json(verifyReversalPending),
				"GET /refund": () => json(emptyRefundList),
				"POST /refund": () =>
					json({ ...createdRefund, data: { ...createdRefund.data, status: paystackStatus } }),
			});
			const result = await paystackPaymentProvider.refund(
				ctx,
				{ refundRequestId: "r1", paymentReference: "dc-x", amount: 10000, currency: "KES" },
				credentials,
			);
			expect(result.status).toBe(expected);
		}
	});
});

describe("getPaymentStatus: full transaction-status mapping", () => {
	it("treats a partly refunded transaction (live reversal-pending response) as paid", async () => {
		const { ctx } = fakePaystack({
			"GET /transaction/verify/T877626421263494": () => json(verifyReversalPending),
			// The live refund list for it: KES 200 of KES 1,000 refunded.
			"GET /refund": () => json(refundList),
		});
		const status = await paystackPaymentProvider.getPaymentStatus?.(
			ctx,
			"T877626421263494",
			credentials,
		);
		expect(status?.status).toBe("succeeded");
		expect(status?.amount).toBe(100000);
		expect(status?.currency).toBe("KES");
		expect(status?.paymentReference).toBe("T877626421263494");
	});

	it("maps every status in Paystack's docs, plus the reversal-pending the API returns", async () => {
		for (const [paystackStatus, expected] of [
			["success", "succeeded"],
			["reversed", "succeeded"],
			["reversal-pending", "succeeded"],
			["failed", "failed"],
			["abandoned", "pending"],
			["ongoing", "pending"],
			["pending", "pending"],
			["processing", "pending"],
			["queued", "pending"],
		] as const) {
			const { ctx } = fakePaystack({
				"GET /transaction/verify/dc-x": () =>
					json({
						...verifyReversalPending,
						data: { ...verifyReversalPending.data, status: paystackStatus },
					}),
				"GET /refund": () => json(emptyRefundList),
			});
			const status = await paystackPaymentProvider.getPaymentStatus?.(ctx, "dc-x", credentials);
			expect({ paystackStatus, status: status?.status }).toEqual({
				paystackStatus,
				status: expected,
			});
		}
	});

	it("never reports an unknown status as paid or failed", async () => {
		const { ctx } = fakePaystack({
			"GET /transaction/verify/dc-x": () =>
				json({
					...verifyReversalPending,
					data: { ...verifyReversalPending.data, status: "something-new" },
				}),
		});
		const status = await paystackPaymentProvider.getPaymentStatus?.(ctx, "dc-x", credentials);
		expect(status?.status).toBe("pending");
		expect(status?.reason).toContain("something-new");
	});
});

describe("Paystack-Signature verification", () => {
	// Obviously fake; the real secret lives only in the merchant's settings.
	const whsec = "whsec_1234567890abcdef";
	const body = '{"event":"charge.success","data":{"id":1,"amount":1.50}}';

	function v1(secret: string, t: number, raw: string): string {
		return createHmac("sha512", secret).update(`${t}.${raw}`).digest("hex");
	}
	const now = () => Math.floor(Date.now() / 1000);

	it("accepts a valid signature through the provider", async () => {
		const t = now();
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body,
			signatureHeader: `t=${t},v1=whk_3f9a1c2e:${v1(whsec, t, body)}`,
			secret: whsec,
		});
		expect(result).toEqual({ ok: true });
	});

	it("accepts when any v1 matches, as during secret rotation", async () => {
		const t = now();
		const header = `t=${t},v1=whk_old:${v1("whsec_old_secret_000", t, body)},v1=whk_new:${v1(whsec, t, body)}`;
		const result = await verifyPaystackSignature({
			payload: body,
			signatureHeader: header,
			secret: whsec,
		});
		expect(result.ok).toBe(true);
	});

	it("ignores fields it does not recognise", async () => {
		const t = now();
		const result = await verifyPaystackSignature({
			payload: body,
			signatureHeader: `t=${t},v0=legacy,v1=whk_a:${v1(whsec, t, body)},x=1`,
			secret: whsec,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a signature made with another secret", async () => {
		const t = now();
		const result = await verifyPaystackSignature({
			payload: body,
			signatureHeader: `t=${t},v1=whk_a:${v1("whsec_other_secret_00", t, body)}`,
			secret: whsec,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Signature mismatch");
	});

	it("rejects a body changed after signing", async () => {
		const t = now();
		const result = await verifyPaystackSignature({
			payload: body.replace("1.50", "1.5"),
			signatureHeader: `t=${t},v1=whk_a:${v1(whsec, t, body)}`,
			secret: whsec,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects a signature whose timestamp was altered", async () => {
		const t = now();
		const result = await verifyPaystackSignature({
			payload: body,
			signatureHeader: `t=${t + 1},v1=whk_a:${v1(whsec, t, body)}`,
			secret: whsec,
		});
		expect(result.ok).toBe(false);
	});

	it("accepts exactly 300 seconds of skew and rejects 301, either way", async () => {
		const nowSeconds = 1_760_270_400;
		const at = async (t: number) =>
			(
				await verifyPaystackSignature({
					payload: body,
					signatureHeader: `t=${t},v1=whk_a:${v1(whsec, t, body)}`,
					secret: whsec,
					nowSeconds,
				})
			).ok;
		expect(await at(nowSeconds - 300)).toBe(true);
		expect(await at(nowSeconds + 300)).toBe(true);
		expect(await at(nowSeconds - 301)).toBe(false);
		expect(await at(nowSeconds + 301)).toBe(false);
	});

	it("signs the timestamp exactly as sent", async () => {
		const nowSeconds = 1_760_270_400;
		const raw = `0${nowSeconds}`;
		const sig = createHmac("sha512", whsec).update(`${raw}.${body}`).digest("hex");
		const result = await verifyPaystackSignature({
			payload: body,
			signatureHeader: `t=${raw},v1=whk_a:${sig}`,
			secret: whsec,
			nowSeconds,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a header with no timestamp, two timestamps, or no v1", async () => {
		const t = now();
		const sig = v1(whsec, t, body);
		for (const header of [
			`v1=whk_a:${sig}`,
			`t=${t},t=${t},v1=whk_a:${sig}`,
			`t=abc,v1=whk_a:${sig}`,
			`t=${t}`,
			`t=${t},v1=whk_a:not-hex`,
		]) {
			const result = await verifyPaystackSignature({
				payload: body,
				signatureHeader: header,
				secret: whsec,
			});
			expect({ header, ok: result.ok }).toEqual({ header, ok: false });
		}
	});

	it("says which secret is needed when an sk_ key is configured for the new header", async () => {
		const t = now();
		const result = await verifyPaystackSignature({
			payload: body,
			signatureHeader: `t=${t},v1=whk_a:${v1(whsec, t, body)}`,
			secret: credentials.secretKey,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("whsec_");
	});

	it("still accepts the legacy x-paystack-signature, keyed with the secret key", async () => {
		const legacy = createHmac("sha512", credentials.secretKey).update(body).digest("hex");
		const result = await paystackPaymentProvider.verifyWebhook({
			rawBody: body,
			signatureHeader: legacy,
			secret: credentials.secretKey,
		});
		expect(result.ok).toBe(true);
	});
});

describe("refund guard: fails loudly", () => {
	it("refuses to refund when verify gives no numeric transaction id", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/dc-x": () =>
				json({ status: true, message: "ok", data: { reference: "dc-x", status: "success" } }),
		});
		await expect(
			paystackPaymentProvider.refund(
				ctx,
				{ refundRequestId: "r1", paymentReference: "dc-x", amount: 100, currency: "KES" },
				credentials,
			),
		).rejects.toThrow(/numeric transaction id/);
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("stops paging rather than loop on an absurd page count", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/dc-x": () => json(verifyReversalPending),
			"GET /refund": () =>
				json({ ...emptyRefundList, meta: { ...emptyRefundList.meta, pageCount: 1_000_000 } }),
		});
		await expect(
			paystackPaymentProvider.refund(
				ctx,
				{ refundRequestId: "r1", paymentReference: "dc-x", amount: 100, currency: "KES" },
				credentials,
			),
		).rejects.toThrow(/pages of refunds/);
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});
});

describe("getPaymentStatus: a payment refunded in full before its order exists", () => {
	// Paystack reports `reversed` / `reversal-pending` after partial refunds
	// too, so only the refunded total can tell a fully returned payment apart.
	const refunds = (...rows: Array<[number, string, number]>) => ({
		...emptyRefundList,
		data: rows.map(([id, status, amount]) => ({
			id,
			status,
			amount,
			currency: "KES",
			transaction_reference: "dc-x",
		})),
		meta: { ...emptyRefundList.meta, total: rows.length, pageCount: 1 },
	});
	const verifyAs = (status: string) => () =>
		json({ ...verifyReversalPending, data: { ...verifyReversalPending.data, status } });

	it("does not confirm a payment whose refunds add up to the whole amount", async () => {
		for (const status of ["reversed", "reversal-pending"]) {
			const { ctx } = fakePaystack({
				"GET /transaction/verify/dc-x": verifyAs(status),
				"GET /refund": () => json(refunds([1, "processed", 60000], [2, "pending", 40000])),
			});
			const result = await paystackPaymentProvider.getPaymentStatus?.(ctx, "dc-x", credentials);
			expect(result?.status).toBe("failed");
			expect(result?.reason).toContain("refunded in full");
		}
	});

	it("leaves failed refunds out of the total", async () => {
		const { ctx } = fakePaystack({
			"GET /transaction/verify/dc-x": verifyAs("reversed"),
			"GET /refund": () => json(refunds([1, "failed", 100000], [2, "processed", 10000])),
		});
		const result = await paystackPaymentProvider.getPaymentStatus?.(ctx, "dc-x", credentials);
		expect(result?.status).toBe("succeeded");
	});

	it("does not list refunds for a transaction that was never reversed", async () => {
		const { ctx, calls } = fakePaystack({
			"GET /transaction/verify/dc-x": verifyAs("success"),
		});
		const result = await paystackPaymentProvider.getPaymentStatus?.(ctx, "dc-x", credentials);
		expect(result?.status).toBe("succeeded");
		expect(calls.map((c) => c.url)).toEqual(["https://api.paystack.co/transaction/verify/dc-x"]);
	});
});

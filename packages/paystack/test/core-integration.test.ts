/**
 * Runs @dashcommerce/paystack through @dashcommerce/core's own route
 * handlers (create-session → webhook → order).
 *
 * The HTTP stub behaves like Paystack where it matters: initialize echoes
 * the reference it was given, and verify answers only for a reference that
 * initialize issued (404 otherwise), so a provider that verifies by the
 * wrong identifier fails here instead of in production.
 */

import { describe, expect, it } from "bun:test";
import { type CartState, type Order, dashcommerce } from "@dashcommerce/core";
import {
	getPaymentProvider,
	registerPaymentProvider,
	resolveProvider,
} from "@dashcommerce/core/payment-provider";
import sandbox from "@dashcommerce/core/sandbox";
import { registerPaystackProvider } from "../src/index";
import { paystackPaymentProvider } from "../src/provider";

const SECRET_KEY = "sk_test_1234567890abcdef";

async function sign(secret: string, payload: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-512" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

interface FakePaystackOptions {
	/** Amount Paystack records as charged. Defaults to what initialize was asked for. */
	chargedAmount?: number;
	/** Status verify reports. Defaults to "success". */
	verifyStatus?: string;
	/** Number of verify calls that fail with a 503 before Paystack recovers. */
	verifyOutages?: number;
	/** Milliseconds verify takes to answer, so two deliveries can overlap. */
	verifyDelayMs?: number;
	/** Currencies the merchant's Paystack account is not enabled for. */
	refusedCurrencies?: string[];
}

/**
 * A Paystack stand-in that only knows the transactions it initialised,
 * requires the secret key on every call, and records what it charged.
 */
function fakePaystack(options: FakePaystackOptions = {}) {
	const transactions = new Map<string, { id: number; amount: number; currency: string }>();
	const refunds: Array<Record<string, unknown>> = [];
	let nextId = 55443322;
	let lastInit: Record<string, unknown> | null = null;
	let outagesLeft = options.verifyOutages ?? 0;
	let verifyCalls = 0;

	async function fetch(url: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers);
		if (headers.get("Authorization") !== `Bearer ${SECRET_KEY}`) {
			return json({ status: false, message: "Invalid key" }, 401);
		}
		const { pathname } = new URL(url);
		if (pathname === "/transaction/initialize") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			lastInit = body;
			if (options.refusedCurrencies?.includes(String(body.currency))) {
				return json(
					{
						status: false,
						message: "Currency not supported by merchant",
						code: "unsupported_currency",
					},
					403,
				);
			}
			const reference = String(body.reference);
			if (!/^[A-Za-z0-9.=-]+$/.test(reference)) {
				return json({ status: false, message: "Invalid transaction reference" }, 400);
			}
			if (!Number.isInteger(body.amount)) {
				return json({ status: false, message: "Amount must be an integer in subunits" }, 400);
			}
			transactions.set(reference, {
				id: nextId++,
				amount: options.chargedAmount ?? (body.amount as number),
				currency: String(body.currency),
			});
			return json({
				status: true,
				message: "Authorization URL created",
				data: {
					authorization_url: "https://checkout.paystack.com/test-access-code",
					access_code: "test-access-code",
					reference,
				},
			});
		}
		if (pathname.startsWith("/transaction/verify/")) {
			verifyCalls++;
			if (options.verifyDelayMs) {
				await new Promise((resolve) => setTimeout(resolve, options.verifyDelayMs));
			}
			if (outagesLeft > 0) {
				outagesLeft--;
				return json({ status: false, message: "Service unavailable" }, 503);
			}
			const reference = decodeURIComponent(pathname.slice("/transaction/verify/".length));
			const tx = transactions.get(reference);
			if (!tx) return json({ status: false, message: "Transaction reference not found" }, 404);
			return json({
				status: true,
				message: "Verification successful",
				data: {
					...tx,
					status: options.verifyStatus ?? "success",
					reference,
					channel: "mobile_money",
				},
			});
		}
		if (pathname === "/refund" && (init?.method ?? "GET") === "GET") {
			// As the live API: filtering by a reference instead of the numeric
			// transaction id silently returns nothing.
			const filter = new URL(url).searchParams.get("transaction");
			const created = refunds
				.filter((r) => String(r.transactionId) === filter)
				.map((r) => ({
					id: r.id,
					status: "pending",
					amount: r.amount,
					currency: r.currency,
					merchant_note: r.merchant_note,
					createdAt: r.createdAt,
				}));
			return json({
				status: true,
				message: "Refunds retrieved",
				data: created,
				meta: { total: created.length, page: 1, pageCount: created.length ? 1 : 0 },
			});
		}
		if (pathname === "/refund") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const tx = transactions.get(String(body.transaction));
			if (!tx) return json({ status: false, message: "Transaction not found" }, 404);
			const id = 887766 + refunds.length;
			refunds.push({
				...body,
				id,
				transactionId: tx.id,
				amount: body.amount ?? tx.amount,
				currency: tx.currency,
				createdAt: new Date(Date.UTC(2026, 10, 19, 2, refunds.length)).toISOString(),
			});
			return json({
				status: true,
				message: "Refund has been queued for processing",
				data: {
					id,
					status: "pending",
					amount: body.amount ?? tx.amount,
					currency: tx.currency,
				},
			});
		}
		return json({ status: false, message: "Not found" }, 404);
	}

	return {
		fetch,
		transactions,
		refunds,
		getLastInit: () => lastInit,
		getVerifyCalls: () => verifyCalls,
	};
}

// Core's real storage config, so the stub enforces the same unique indexes
// the database does (dedup relies on them).
const CORE_STORAGE = dashcommerce().storage as Record<string, { uniqueIndexes?: string[] }>;

function makeContext(
	initialKv: Record<string, unknown>,
	fetchImpl: typeof fetch | ((url: string, init?: RequestInit) => Promise<Response>),
) {
	const kvStore = new Map<string, unknown>(Object.entries(initialKv));
	const collections = new Map<string, Map<string, unknown>>();
	const getCol = (name: string) => {
		let col = collections.get(name);
		if (!col) {
			col = new Map();
			collections.set(name, col);
		}
		return col;
	};

	const storage = new Proxy(
		{},
		{
			get(_target, prop: string) {
				const col = getCol(prop);
				return {
					async get(id: string) {
						return col.get(id) ?? null;
					},
					async put(id: string, data: unknown) {
						const row = data as Record<string, unknown>;
						for (const field of CORE_STORAGE[prop]?.uniqueIndexes ?? []) {
							if (row[field] === undefined || row[field] === null) continue;
							for (const [otherId, other] of col) {
								if (otherId !== id && (other as Record<string, unknown>)[field] === row[field]) {
									throw new Error(`UNIQUE constraint failed: ${prop}.${field}`);
								}
							}
						}
						col.set(id, data);
					},
					async putMany(items: Array<{ id: string; data: unknown }>) {
						for (const item of items) col.set(item.id, item.data);
					},
					async delete(id: string) {
						col.delete(id);
					},
					async query(opts?: { where?: Record<string, unknown>; limit?: number }) {
						const all = Array.from(col.entries()).map(([id, data]) => ({ id, data }));
						const where = opts?.where;
						if (!where) return { items: all, hasMore: false };
						const items = all.filter((item) => {
							const d = item.data as Record<string, unknown>;
							return Object.entries(where).every(([k, v]) => d[k] === v);
						});
						return { items, hasMore: false };
					},
					async count() {
						return col.size;
					},
				};
			},
		},
	);

	const products = new Map([
		[
			"prod_ticket",
			{
				id: "prod_ticket",
				status: "published",
				data: {
					title: "Matchday ticket",
					type: "simple",
					prices: { KES: { amount: 150000 } },
					virtual: true,
					manage_stock: false,
				},
			},
		],
	]);

	const ctx = {
		kv: {
			async get<T>(key: string): Promise<T | null> {
				return (kvStore.get(key) as T) ?? null;
			},
			async set(key: string, value: unknown) {
				kvStore.set(key, value);
			},
			async delete(key: string) {
				kvStore.delete(key);
			},
		},
		storage,
		content: {
			async get(collection: string, id: string) {
				return collection === "products" ? (products.get(id) ?? null) : null;
			},
		},
		http: { fetch: fetchImpl },
		site: { url: "https://test.dashcommerce.dev" },
		log: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as import("emdash").PluginContext;

	return { ctx, getCol };
}

function ticketCart(sessionId: string): CartState {
	const kes = (amount: number) => ({ amount, currency: "KES" });
	const address = { line1: "Ngong Road", city: "Nairobi", country: "KE" };
	return {
		sessionId,
		currency: "KES",
		customerEmail: "supporter@example.com",
		billingAddress: address,
		shippingAddress: address,
		items: [
			{
				lineId: "line_1",
				productId: "prod_ticket",
				quantity: 1,
				title: "Matchday ticket",
				isDigital: true,
				unitPrice: kes(150000),
				lineSubtotal: kes(150000),
			},
		],
		coupons: [],
		taxLines: [],
		subtotal: kes(150000),
		discountTotal: kes(0),
		shippingTotal: kes(0),
		taxTotal: kes(0),
		total: kes(150000),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	} as unknown as CartState;
}

const paystackSettings = {
	"settings:paymentProvider": "paystack",
	"settings:paystackSecretKey": SECRET_KEY,
	// Paystack signs webhooks with the secret key; core reads the signing
	// secret from this key, so a merchant stores the secret key here too.
	"settings:paystackWebhookSecret": SECRET_KEY,
};

async function startCheckout(ctx: import("emdash").PluginContext, sessionId: string) {
	await ctx.kv.set(`cart:${sessionId}`, ticketCart(sessionId));
	const request = new Request("http://test/checkout/create-session", {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: `dashcommerce_sid=${sessionId}` },
		body: JSON.stringify({ customerEmail: "supporter@example.com" }),
	});
	const routeCtx = {
		...ctx,
		request,
		input: { customerEmail: "supporter@example.com" },
	} as unknown as import("emdash").RouteContext;
	return (await sandbox.routes["checkout/create-session"].handler(routeCtx, ctx)) as Response;
}

async function deliverWebhook(
	ctx: import("emdash").PluginContext,
	payload: string,
	signature: string | Record<string, string>,
	url = "http://test/checkout/webhook",
) {
	const request = new Request(url, {
		method: "POST",
		headers: typeof signature === "string" ? { "x-paystack-signature": signature } : signature,
		body: payload,
	});
	const routeCtx = { ...ctx, request } as unknown as import("emdash").RouteContext;
	try {
		return (await sandbox.routes["checkout/webhook"].handler(routeCtx, ctx)) as Response;
	} catch (err) {
		// EmDash turns a thrown route error into a 500.
		return json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
}

function chargeSuccess(reference: string, orderDraftId: string, id: number, amount = 150000) {
	return JSON.stringify({
		event: "charge.success",
		data: {
			id,
			reference,
			amount,
			currency: "KES",
			status: "success",
			customer: { email: "supporter@example.com", first_name: "Aidi", last_name: "Onyango" },
			channel: "mobile_money",
			metadata: { orderDraftId },
		},
	});
}

describe("@dashcommerce/paystack through core", () => {
	it("registers on import and resolves as the configured provider", async () => {
		expect(getPaymentProvider("paystack")).toBe(paystackPaymentProvider);
		const { ctx } = makeContext({ "settings:paymentProvider": "paystack" }, fakePaystack().fetch);
		expect((await resolveProvider(ctx.kv)).id).toBe("paystack");
	});

	it("registering again is a no-op, but a different provider under the same id fails loudly", () => {
		expect(() => registerPaystackProvider()).not.toThrow();
		expect(() =>
			registerPaymentProvider({ ...paystackPaymentProvider, label: "Impostor" }),
		).toThrow(/already registered/);
		expect(getPaymentProvider("paystack")).toBe(paystackPaymentProvider);
	});

	it("runs checkout → signed webhook → verified order, and ignores a replay", async () => {
		const paystack = fakePaystack();
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);

		const initRes = await startCheckout(ctx, "sess_paystack_1");
		expect(initRes.status).toBe(200);
		const { url, orderDraftId } = (await initRes.json()) as { url: string; orderDraftId: string };
		expect(url).toBe("https://checkout.paystack.com/test-access-code");

		const reference = String(paystack.getLastInit()?.reference);
		expect(reference).toBe(`dc-${orderDraftId}`);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");

		const payload = chargeSuccess(reference, orderDraftId, tx.id);
		const signature = await sign(SECRET_KEY, payload);
		const webhookRes = await deliverWebhook(ctx, payload, signature);
		expect(webhookRes.status).toBe(200);

		const orders = getCol("orders");
		expect(orders.size).toBe(1);
		const order = Array.from(orders.values())[0] as Order;
		expect(order.providerId).toBe("paystack");
		expect(order.paymentReference).toBe(reference);
		expect(order.checkoutReference).toBe(reference);
		expect(order.total.amount).toBe(150000);
		expect(order.total.currency).toBe("KES");
		expect(order.paymentStatus).toBe("paid");

		const replay = await deliverWebhook(ctx, payload, signature);
		expect(replay.status).toBe(200);
		expect(((await replay.json()) as { duplicate?: boolean }).duplicate).toBe(true);
		expect(orders.size).toBe(1);
	});

	it("tells the customer when the Paystack account refuses the cart's currency", async () => {
		const paystack = fakePaystack({ refusedCurrencies: ["KES"] });
		const { ctx } = makeContext(paystackSettings, paystack.fetch);
		const res = await startCheckout(ctx, "sess_paystack_currency");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; code?: string; currency?: string };
		expect(body.code).toBe("currency_not_supported");
		expect(body.currency).toBe("KES");
		expect(body.error).toBe(
			"This shop can't take payments in KES right now. Choose another currency, or contact the shop.",
		);
	});

	it("creates no order for a signed event whose reference Paystack does not know", async () => {
		const paystack = fakePaystack();
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_2");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };

		const payload = chargeSuccess("dc-not-a-real-transaction", orderDraftId, 1);
		const res = await deliverWebhook(ctx, payload, await sign(SECRET_KEY, payload));
		expect(res.status).not.toBe(200);
		expect(getCol("orders").size).toBe(0);
	});

	it("rejects a webhook signed with the wrong key before any side effect", async () => {
		const paystack = fakePaystack();
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_3");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);

		const payload = chargeSuccess(reference, orderDraftId, 1);
		const res = await deliverWebhook(ctx, payload, await sign("sk_test_wrong_key", payload));
		expect(res.status).toBe(400);
		expect(getCol("orders").size).toBe(0);
	});

	it("holds the order when Paystack confirms a different amount than the cart", async () => {
		// The payload claims the full amount; Paystack's own record says less.
		const paystack = fakePaystack({ chargedAmount: 100 });
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_4");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");

		const payload = chargeSuccess(reference, orderDraftId, tx.id, 150000);
		const res = await deliverWebhook(ctx, payload, await sign(SECRET_KEY, payload));
		expect(res.status).toBe(200);

		// Core trusts Paystack's verified record over the webhook body and
		// puts the order on hold for an operator to review.
		const order = Array.from(getCol("orders").values())[0] as Order & {
			metadata?: Record<string, unknown>;
		};
		expect(order).toBeDefined();
		expect(order.status).toBe("on-hold");
		expect(order.metadata?.paymentAmountMismatch).toBe(true);
		expect(order.metadata?.receivedAmount).toBe(100);
	});
	it("creates the order when Paystack's retry follows a failed first delivery", async () => {
		// Paystack is briefly down when core confirms the first delivery, so
		// core answers 500. Paystack's retry must still produce the order.
		const paystack = fakePaystack({ verifyOutages: 1 });
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_5");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");

		const payload = chargeSuccess(reference, orderDraftId, tx.id);
		const signature = await sign(SECRET_KEY, payload);

		const first = await deliverWebhook(ctx, payload, signature);
		expect(first.status).toBe(500);
		expect(getCol("orders").size).toBe(0);

		const retry = await deliverWebhook(ctx, payload, signature);
		expect(retry.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});

	it("creates no order when Paystack reports the transaction as not successful", async () => {
		const paystack = fakePaystack({ verifyStatus: "abandoned" });
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_6");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");

		const payload = chargeSuccess(reference, orderDraftId, tx.id);
		const res = await deliverWebhook(ctx, payload, await sign(SECRET_KEY, payload));
		expect(res.status).not.toBe(200);
		expect(getCol("orders").size).toBe(0);
	});

	it("finds the draft from the reference when Paystack returns no metadata", async () => {
		const paystack = fakePaystack();
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_7");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");

		const event = JSON.parse(chargeSuccess(reference, orderDraftId, tx.id));
		const { metadata: _omitted, ...data } = event.data;
		const payload = JSON.stringify({ ...event, data });
		const res = await deliverWebhook(ctx, payload, await sign(SECRET_KEY, payload));
		expect(res.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});

	it("sends Paystack a callback URL without Stripe's session placeholder", async () => {
		const paystack = fakePaystack();
		const { ctx } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_8");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };

		const callback = new URL(String(paystack.getLastInit()?.callback_url));
		expect(callback.pathname).toBe(`/thank-you/${orderDraftId}`);
		expect(callback.search).toBe("");
		expect(String(paystack.getLastInit()?.callback_url)).not.toContain("CHECKOUT_SESSION_ID");
	});

	it("charges the cart total in subunits and refunds the order's payment", async () => {
		const paystack = fakePaystack();
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_9");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		expect(paystack.getLastInit()?.amount).toBe(150000);
		expect(paystack.getLastInit()?.currency).toBe("KES");

		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");
		const payload = chargeSuccess(reference, orderDraftId, tx.id);
		await deliverWebhook(ctx, payload, await sign(SECRET_KEY, payload));
		const order = Array.from(getCol("orders").values())[0] as Order;

		const refund = await paystackPaymentProvider.refund(
			{ http: ctx.http, log: ctx.log },
			{
				refundRequestId: "refund-req-1",
				paymentReference: order.paymentReference ?? "",
				amount: 50000,
				currency: "KES",
			},
			{ secretKey: SECRET_KEY },
		);
		expect(paystack.refunds).toHaveLength(1);
		expect(paystack.refunds[0]?.transaction).toBe(reference);
		expect(paystack.refunds[0]?.amount).toBe(50000);
		expect(refund.status).toBe("pending");

		// A retry with the same request id (say the first response timed out)
		// returns the first refund; Paystack itself would accept a second one.
		const retry = await paystackPaymentProvider.refund(
			{ http: ctx.http, log: ctx.log },
			{
				refundRequestId: "refund-req-1",
				paymentReference: order.paymentReference ?? "",
				amount: 50000,
				currency: "KES",
			},
			{ secretKey: SECRET_KEY },
		);
		expect(paystack.refunds).toHaveLength(1);
		expect(retry.providerRefundId).toBe(refund.providerRefundId);

		// A different request for the same amount is a new, legitimate refund.
		await paystackPaymentProvider.refund(
			{ http: ctx.http, log: ctx.log },
			{
				refundRequestId: "refund-req-2",
				paymentReference: order.paymentReference ?? "",
				amount: 50000,
				currency: "KES",
			},
			{ secretKey: SECRET_KEY },
		);
		expect(paystack.refunds).toHaveLength(2);
	});
});

// ── With core enablement ────────────────────────────────────────────────────

const WHSEC = "whsec_1234567890abcdef";

async function paystackSignatureHeader(payload: string, t = Math.floor(Date.now() / 1000)) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(WHSEC),
		{ name: "HMAC", hash: "SHA-512" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
	return `t=${t},v1=whk_test:${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A paid Paystack order with one KES 500 refund still pending at Paystack. */
async function paidOrderWithPendingRefund(session: string) {
	const paystack = fakePaystack();
	const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
	const initRes = await startCheckout(ctx, session);
	const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
	const reference = String(paystack.getLastInit()?.reference);
	const tx = paystack.transactions.get(reference);
	if (!tx) throw new Error("initialize did not register a transaction");
	const charge = chargeSuccess(reference, orderDraftId, tx.id);
	await deliverWebhook(ctx, charge, await sign(SECRET_KEY, charge));
	const order = Array.from(getCol("orders").values())[0] as Order;

	// Create the refund through the admin route, as a merchant would.
	const refundRes = (await sandbox.routes["admin/orders/refund"].handler(
		{
			request: new Request(`http://test/admin/orders/refund?id=${order.id}`, { method: "POST" }),
			input: { amount: 50000, currency: "KES" },
		} as unknown as import("emdash").RouteContext,
		ctx,
	)) as Response;
	expect(refundRes.status).toBe(200);
	const refundRow = Array.from(getCol("refunds").values())[0] as { status: string };
	expect(refundRow.status).toBe("pending");
	const refundId = Number(paystack.refunds[0]?.id);
	return { ctx, getCol, reference, refundId, order };
}

describe("@dashcommerce/paystack with core enablement", () => {
	it("saves a restricted key and a whsec_ secret through the settings API", async () => {
		const { ctx } = makeContext({}, fakePaystack().fetch);
		const routeCtx = {
			request: new Request("http://test/admin/settings", { method: "POST" }),
			input: {
				paymentProvider: "paystack",
				paystackSecretKey: "rk_test_1234567890abcdef",
				paystackWebhookSecret: WHSEC,
			},
		} as unknown as import("emdash").RouteContext;
		const res = (await sandbox.routes["admin/settings"].handler(routeCtx, ctx)) as Response;
		expect(res.status).toBe(200);
		expect(await ctx.kv.get("settings:paystackSecretKey")).toBe("rk_test_1234567890abcdef");

		const bad = (await sandbox.routes["admin/settings"].handler(
			{
				request: new Request("http://test/admin/settings", { method: "POST" }),
				input: { paystackSecretKey: "pk_test_public_key" },
			} as unknown as import("emdash").RouteContext,
			ctx,
		)) as Response;
		expect(bad.status).toBe(400);
	});

	it("creates the order from a Paystack-Signature webhook verified with the whsec_ secret", async () => {
		const paystack = fakePaystack();
		const { ctx, getCol } = makeContext(
			{ ...paystackSettings, "settings:paystackWebhookSecret": WHSEC },
			paystack.fetch,
		);
		const initRes = await startCheckout(ctx, "sess_paystack_v2");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");
		const payload = chargeSuccess(reference, orderDraftId, tx.id);

		const res = await deliverWebhook(ctx, payload, {
			"Paystack-Signature": await paystackSignatureHeader(payload),
		});
		expect(res.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});

	it("verifies whichever header matches the configured secret when Paystack sends both", async () => {
		const paystack = fakePaystack();
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_both");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");
		const payload = chargeSuccess(reference, orderDraftId, tx.id);

		// The merchant still has the sk_ key as webhook secret (legacy header).
		const res = await deliverWebhook(ctx, payload, {
			"Paystack-Signature": await paystackSignatureHeader(payload),
			"x-paystack-signature": await sign(SECRET_KEY, payload),
		});
		expect(res.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});

	it("rejects a replayed Paystack-Signature older than five minutes", async () => {
		const paystack = fakePaystack();
		const { ctx, getCol } = makeContext(
			{ ...paystackSettings, "settings:paystackWebhookSecret": WHSEC },
			paystack.fetch,
		);
		const initRes = await startCheckout(ctx, "sess_paystack_old");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");
		const payload = chargeSuccess(reference, orderDraftId, tx.id);

		const res = await deliverWebhook(ctx, payload, {
			"Paystack-Signature": await paystackSignatureHeader(
				payload,
				Math.floor(Date.now() / 1000) - 301,
			),
		});
		expect(res.status).toBe(400);
		expect(getCol("orders").size).toBe(0);
	});

	it("moves a refund to succeeded when Paystack reports refund.processed", async () => {
		const { ctx, getCol, reference, refundId } = await paidOrderWithPendingRefund(
			"sess_paystack_refund_evt",
		);

		const event = JSON.stringify({
			event: "refund.processed",
			data: {
				id: refundId,
				status: "processed",
				transaction_reference: reference,
				amount: 50000,
				currency: "KES",
			},
		});
		const res = await deliverWebhook(ctx, event, await sign(SECRET_KEY, event));
		expect(res.status).toBe(200);
		expect((Array.from(getCol("refunds").values())[0] as { status: string }).status).toBe(
			"succeeded",
		);
	});

	it("reverses a failed refund once when Paystack delivers refund.failed twice at the same time", async () => {
		const { ctx, getCol, reference, refundId, order } = await paidOrderWithPendingRefund(
			"sess_paystack_refund_failed_twice",
		);
		expect((getCol("orders").get(order.id) as Order).refundedTotal.amount).toBe(50000);

		const event = JSON.stringify({
			event: "refund.failed",
			data: { id: String(refundId), status: "failed", transaction_reference: reference },
		});
		const signature = await sign(SECRET_KEY, event);
		const responses = await Promise.all([
			deliverWebhook(ctx, event, signature),
			deliverWebhook(ctx, event, signature),
		]);
		const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
			duplicate?: boolean;
			refund?: string;
		}>;
		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		// One delivery runs the handler; core's event dedup skips the other.
		expect(bodies.filter((b) => b.duplicate === true)).toHaveLength(1);
		expect(bodies.filter((b) => b.refund === "updated")).toHaveLength(1);

		const refund = Array.from(getCol("refunds").values())[0] as { status: string };
		expect(refund.status).toBe("failed");
		const after = getCol("orders").get(order.id) as Order;
		expect(after.refundedTotal.amount).toBe(0);
		expect(after.paymentStatus).toBe("paid");
	});

	it("runs refund.failed after refund.pending for the same refund", async () => {
		const { ctx, getCol, reference, refundId, order } = await paidOrderWithPendingRefund(
			"sess_paystack_refund_pending_then_failed",
		);

		const deliver = async (event: string, status: string) => {
			const body = JSON.stringify({
				event,
				data: { id: String(refundId), status, transaction_reference: reference },
			});
			const res = await deliverWebhook(ctx, body, await sign(SECRET_KEY, body));
			expect(res.status).toBe(200);
			return (await res.json()) as { duplicate?: boolean; refund?: string };
		};

		// Each status has its own event id, so the earlier pending event does
		// not make core skip the failure as a duplicate.
		expect(await deliver("refund.pending", "pending")).toMatchObject({ refund: "unchanged" });
		const failed = await deliver("refund.failed", "failed");
		expect(failed.duplicate).toBeUndefined();
		expect(failed.refund).toBe("updated");
		expect((getCol("orders").get(order.id) as Order).refundedTotal.amount).toBe(0);
	});

	it("runs overlapping charge.success deliveries once", async () => {
		// A slow verify keeps the first delivery in flight while the second arrives.
		const paystack = fakePaystack({ verifyDelayMs: 20 });
		const { ctx, getCol } = makeContext(paystackSettings, paystack.fetch);
		const initRes = await startCheckout(ctx, "sess_paystack_overlap");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const reference = String(paystack.getLastInit()?.reference);
		const tx = paystack.transactions.get(reference);
		if (!tx) throw new Error("initialize did not register a transaction");

		const payload = chargeSuccess(reference, orderDraftId, tx.id);
		const signature = await sign(SECRET_KEY, payload);
		const responses = await Promise.all([
			deliverWebhook(ctx, payload, signature),
			deliverWebhook(ctx, payload, signature),
		]);
		const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
			duplicate?: boolean;
		}>;
		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(bodies.filter((b) => b.duplicate === true)).toHaveLength(1);
		expect(getCol("orders").size).toBe(1);
		// Only one delivery got as far as confirming with Paystack.
		expect(paystack.getVerifyCalls()).toBe(1);
	});
});

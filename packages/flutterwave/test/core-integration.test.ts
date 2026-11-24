/**
 * Runs @dashcommerce/flutterwave through @dashcommerce/core's own route
 * handlers (create-session → webhook → order → refund).
 *
 * The HTTP stub behaves like Flutterwave where it matters: the hosted link
 * is issued for the `tx_ref` it was given, verification answers only for a
 * transaction it issued, and amounts cross the boundary in major units while
 * core keeps minor units.
 */

import { describe, expect, it } from "bun:test";
import { type CartState, type Order, dashcommerce } from "@dashcommerce/core";
import {
	getPaymentProvider,
	registerPaymentProvider,
	resolveProvider,
} from "@dashcommerce/core/payment-provider";
import sandbox from "@dashcommerce/core/sandbox";
import { registerFlutterwaveProvider } from "../src/index";
import { flutterwavePaymentProvider } from "../src/provider";

const SECRET_KEY = "FLWSECK_TEST-1234567890abcdef-X";
const SECRET_HASH = "flw-test-secret-hash";
const PUBLIC_KEY = "FLWPUBK_TEST-1234567890abcdef-X";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

interface FakeFlutterwaveOptions {
	/** Minor units Flutterwave records as charged. Defaults to what checkout was asked for. */
	chargedAmountMinor?: number;
	/** Status verify reports. Defaults to "successful". */
	verifyStatus?: string;
	/** Number of verify calls that fail with a 503 before Flutterwave recovers. */
	verifyOutages?: number;
	/** Milliseconds verify takes to answer, so two deliveries can overlap. */
	verifyDelayMs?: number;
}

interface FakeTransaction {
	id: number;
	amountMinor: number;
	currency: string;
	status: string;
}

/**
 * A Flutterwave stand-in that only knows the transactions it created,
 * requires the secret key on every call, and records amounts in both
 * directions.
 */
function fakeFlutterwave(options: FakeFlutterwaveOptions = {}) {
	const transactions = new Map<string, FakeTransaction>();
	const refunds: Array<Record<string, unknown>> = [];
	let nextId = 908790;
	let lastInit: Record<string, unknown> | null = null;
	let outagesLeft = options.verifyOutages ?? 0;
	let verifyCalls = 0;

	function verifyResponse(txRef: string, tx: FakeTransaction): Response {
		return json({
			status: "success",
			message: "Transaction fetched successfully",
			data: {
				id: tx.id,
				tx_ref: txRef,
				flw_ref: `FLW-MOCK-${tx.id}`,
				amount: tx.amountMinor / 100,
				currency: tx.currency,
				charged_amount: tx.amountMinor / 100,
				status: options.verifyStatus ?? tx.status,
				processor_response: "Approved",
				payment_type: "mpesa",
				customer: {
					id: 215604089,
					name: "Aidi Onyango",
					phone_number: "+254700000000",
					email: "supporter@example.com",
				},
			},
		});
	}

	async function fetch(url: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers);
		if (headers.get("Authorization") !== `Bearer ${SECRET_KEY}`) {
			return json({ status: "error", message: "Authorization required", data: null }, 401);
		}
		const { pathname, searchParams } = new URL(url);
		const method = init?.method ?? "GET";

		if (pathname === "/v3/payments" && method === "POST") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			lastInit = body;
			const txRef = String(body.tx_ref);
			if (!/^[A-Za-z0-9.=-]+$/.test(txRef)) {
				return json({ status: "error", message: "Invalid transaction reference", data: null }, 400);
			}
			if (typeof body.amount !== "number" || body.amount <= 0) {
				return json({ status: "error", message: "Invalid amount", data: null }, 400);
			}
			transactions.set(txRef, {
				id: nextId++,
				amountMinor: options.chargedAmountMinor ?? Math.round(body.amount * 100),
				currency: String(body.currency),
				status: "successful",
			});
			return json({
				status: "success",
				message: "Hosted Link",
				data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test-link" },
			});
		}

		if (pathname === "/v3/balances") {
			return json({ status: "success", message: "Balances fetched", data: { KES: 1000 } });
		}

		if (pathname === "/v3/transactions/verify_by_reference") {
			verifyCalls++;
			if (options.verifyDelayMs)
				await new Promise((resolve) => setTimeout(resolve, options.verifyDelayMs));
			if (outagesLeft > 0) {
				outagesLeft--;
				return json({ status: "error", message: "Service unavailable", data: null }, 503);
			}
			const txRef = searchParams.get("tx_ref") ?? "";
			const tx = transactions.get(txRef);
			if (!tx) {
				return json(
					{ status: "error", message: "No transaction was found for this id", data: null },
					400,
				);
			}
			return verifyResponse(txRef, tx);
		}

		const verifyById = /^\/v3\/transactions\/(\d+)\/verify$/.exec(pathname);
		if (verifyById) {
			verifyCalls++;
			if (options.verifyDelayMs)
				await new Promise((resolve) => setTimeout(resolve, options.verifyDelayMs));
			if (outagesLeft > 0) {
				outagesLeft--;
				return json({ status: "error", message: "Service unavailable", data: null }, 503);
			}
			const id = Number(verifyById[1]);
			const entry = [...transactions.entries()].find(([, tx]) => tx.id === id);
			if (!entry) {
				return json(
					{ status: "error", message: "No transaction was found for this id", data: null },
					400,
				);
			}
			return verifyResponse(entry[0], entry[1]);
		}

		if (pathname === "/v3/refunds" && method === "GET") {
			return json({
				status: "success",
				message: "Refunds fetched",
				data: refunds,
				meta: {
					page_info: { total: refunds.length, current_page: 1, total_pages: 1, page_size: 20 },
				},
			});
		}

		const refund = /^\/v3\/transactions\/(\d+)\/refund$/.exec(pathname);
		if (refund && method === "POST") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const transactionId = Number(refund[1]);
			const tx = [...transactions.values()].find((entry) => entry.id === transactionId);
			if (!tx) return json({ status: "error", message: "Transaction not found", data: null }, 404);
			const row = {
				id: 8612 + refunds.length,
				account_id: 73362,
				transaction_id: transactionId,
				amount_refunded: typeof body.amount === "number" ? body.amount : tx.amountMinor / 100,
				status: "completed",
				comment: body.comments ?? null,
				flw_ref: `URF_${transactionId}`,
				created_at: new Date(Date.UTC(2026, 10, 19, 2, refunds.length)).toISOString(),
			};
			refunds.push(row);
			return json({ status: "success", message: "Transaction refund initiated", data: row });
		}

		return json({ status: "error", message: "Not found", data: null }, 404);
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

const flutterwaveSettings = {
	"settings:paymentProvider": "flutterwave",
	"settings:flutterwaveSecretKey": SECRET_KEY,
	"settings:flutterwaveWebhookSecret": SECRET_HASH,
};

function vendorRecord(id: string) {
	return {
		id,
		stripeAccountId: "",
		name: `Vendor ${id}`,
		email: `${id}@example.com`,
		onboardingStatus: "active",
		platformFeePercent: 0,
		detailsSubmitted: false,
		chargesEnabled: false,
		payoutsEnabled: false,
		paymentAccounts: {
			flutterwave: {
				accountReference: `RS_${id.toUpperCase()}`,
				status: "active",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		},
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

async function startCheckout(
	ctx: import("emdash").PluginContext,
	sessionId: string,
	cart: CartState = ticketCart(sessionId),
) {
	await ctx.kv.set(`cart:${sessionId}`, cart);
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
	hash: string | Record<string, string>,
	url = "http://test/checkout/webhook",
) {
	const request = new Request(url, {
		method: "POST",
		headers: typeof hash === "string" ? { "verif-hash": hash } : hash,
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

function chargeCompleted(
	txRef: string,
	orderDraftId: string,
	id: number,
	amountMajor = 1500,
	status = "successful",
) {
	return JSON.stringify({
		event: "charge.completed",
		"event.type": "CARD_TRANSACTION",
		data: {
			id,
			tx_ref: txRef,
			flw_ref: `FLW-MOCK-${id}`,
			amount: amountMajor,
			currency: "KES",
			charged_amount: amountMajor,
			status,
			payment_type: "mpesa",
			processor_response: "Approved",
			customer: {
				id: 215604089,
				name: "Aidi Onyango",
				phone_number: "+254700000000",
				email: "supporter@example.com",
			},
			meta: { orderDraftId },
		},
	});
}

describe("@dashcommerce/flutterwave through core", () => {
	it("registers on import and resolves as the configured provider", async () => {
		expect(getPaymentProvider("flutterwave")).toBe(flutterwavePaymentProvider);
		const { ctx } = makeContext(
			{ "settings:paymentProvider": "flutterwave" },
			fakeFlutterwave().fetch,
		);
		expect((await resolveProvider(ctx.kv)).id).toBe("flutterwave");
	});

	it("registering again is a no-op, but a different provider under the same id fails loudly", () => {
		expect(() => registerFlutterwaveProvider()).not.toThrow();
		expect(() =>
			registerPaymentProvider({ ...flutterwavePaymentProvider, label: "Impostor" }),
		).toThrow(/already registered/);
		expect(getPaymentProvider("flutterwave")).toBe(flutterwavePaymentProvider);
	});

	it("runs checkout → signed webhook → verified order, and ignores a replay", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);

		const initRes = await startCheckout(ctx, "sess_flw_1");
		expect(initRes.status).toBe(200);
		const { url, orderDraftId } = (await initRes.json()) as { url: string; orderDraftId: string };
		expect(url).toBe("https://checkout.flutterwave.com/v3/hosted/pay/test-link");

		const txRef = String(flutterwave.getLastInit()?.tx_ref);
		expect(txRef).toBe(`dc-${orderDraftId}`);
		const tx = flutterwave.transactions.get(txRef);
		if (!tx) throw new Error("checkout did not register a transaction");

		const payload = chargeCompleted(txRef, orderDraftId, tx.id);
		const webhookRes = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(webhookRes.status).toBe(200);

		const orders = getCol("orders");
		expect(orders.size).toBe(1);
		const order = Array.from(orders.values())[0] as Order;
		expect(order.providerId).toBe("flutterwave");
		expect(order.paymentReference).toBe(String(tx.id));
		expect(order.checkoutReference).toBe(txRef);
		expect(order.total.amount).toBe(150000);
		expect(order.total.currency).toBe("KES");
		expect(order.paymentStatus).toBe("paid");

		const replay = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(replay.status).toBe(200);
		expect(((await replay.json()) as { duplicate?: boolean }).duplicate).toBe(true);
		expect(orders.size).toBe(1);
	});

	it("creates no order for a signed event whose transaction Flutterwave does not know", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_2");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };

		const payload = chargeCompleted("dc-not-a-real-transaction", orderDraftId, 1);
		const res = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(res.status).not.toBe(200);
		expect(getCol("orders").size).toBe(0);
	});

	it("rejects a webhook with the wrong verif-hash before any side effect", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_3");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const txRef = String(flutterwave.getLastInit()?.tx_ref);

		const payload = chargeCompleted(txRef, orderDraftId, 1);
		const res = await deliverWebhook(ctx, payload, "wrong-hash");
		expect(res.status).toBe(400);
		expect(getCol("orders").size).toBe(0);
	});

	it("holds the order when Flutterwave confirms a different amount than the cart", async () => {
		// The payload claims the full amount; Flutterwave's own record says less.
		const flutterwave = fakeFlutterwave({ chargedAmountMinor: 100 });
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_4");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const txRef = String(flutterwave.getLastInit()?.tx_ref);
		const tx = flutterwave.transactions.get(txRef);
		if (!tx) throw new Error("checkout did not register a transaction");

		const payload = chargeCompleted(txRef, orderDraftId, tx.id, 1500);
		const res = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(res.status).toBe(200);

		const order = Array.from(getCol("orders").values())[0] as Order & {
			metadata?: Record<string, unknown>;
		};
		expect(order).toBeDefined();
		expect(order.status).toBe("on-hold");
		expect(order.metadata?.paymentAmountMismatch).toBe(true);
		expect(order.metadata?.receivedAmount).toBe(100);
	});

	it("creates the order when Flutterwave's retry follows a failed first delivery", async () => {
		// Flutterwave is briefly down when core confirms the first delivery, so
		// core answers 500. Flutterwave's retry must still produce the order.
		const flutterwave = fakeFlutterwave({ verifyOutages: 1 });
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_5");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const txRef = String(flutterwave.getLastInit()?.tx_ref);
		const tx = flutterwave.transactions.get(txRef);
		if (!tx) throw new Error("checkout did not register a transaction");

		const payload = chargeCompleted(txRef, orderDraftId, tx.id);

		const first = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(first.status).toBe(500);
		expect(getCol("orders").size).toBe(0);

		const retry = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(retry.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});

	it("creates no order when Flutterwave reports the transaction as pending", async () => {
		const flutterwave = fakeFlutterwave({ verifyStatus: "pending" });
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_6");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const txRef = String(flutterwave.getLastInit()?.tx_ref);
		const tx = flutterwave.transactions.get(txRef);
		if (!tx) throw new Error("checkout did not register a transaction");

		const payload = chargeCompleted(txRef, orderDraftId, tx.id);
		const res = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(res.status).not.toBe(200);
		expect(getCol("orders").size).toBe(0);
	});

	it("finds the draft from the reference when Flutterwave returns no metadata", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_7");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const txRef = String(flutterwave.getLastInit()?.tx_ref);
		const tx = flutterwave.transactions.get(txRef);
		if (!tx) throw new Error("checkout did not register a transaction");

		const event = JSON.parse(chargeCompleted(txRef, orderDraftId, tx.id));
		const { meta: _meta, ...data } = event.data;
		const payload = JSON.stringify({ ...event, data });
		const res = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(res.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});

	it("sends Flutterwave a callback URL without Stripe's session placeholder", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_8");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };

		const callback = new URL(String(flutterwave.getLastInit()?.redirect_url));
		expect(callback.pathname).toBe(`/thank-you/${orderDraftId}`);
		expect(callback.search).toBe("");
		expect(String(flutterwave.getLastInit()?.redirect_url)).not.toContain("CHECKOUT_SESSION_ID");
	});

	it("charges the cart total in major units and refunds the order's payment", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_9");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		expect(flutterwave.getLastInit()?.amount).toBe(1500);
		expect(flutterwave.getLastInit()?.currency).toBe("KES");

		const txRef = String(flutterwave.getLastInit()?.tx_ref);
		const tx = flutterwave.transactions.get(txRef);
		if (!tx) throw new Error("checkout did not register a transaction");
		const payload = chargeCompleted(txRef, orderDraftId, tx.id);
		await deliverWebhook(ctx, payload, SECRET_HASH);
		const order = Array.from(getCol("orders").values())[0] as Order;

		const refund = await flutterwavePaymentProvider.refund(
			{ http: ctx.http, log: ctx.log },
			{
				refundRequestId: "refund-req-1",
				paymentReference: order.paymentReference ?? "",
				amount: 50000,
				currency: "KES",
			},
			{ secretKey: SECRET_KEY },
		);
		expect(flutterwave.refunds).toHaveLength(1);
		expect(flutterwave.refunds[0]?.transaction_id).toBe(tx.id);
		expect(flutterwave.refunds[0]?.amount_refunded).toBe(500);
		expect(refund.status).toBe("succeeded");
		expect(refund.amount).toBe(50000);

		// A retry with the same request id (say the first response timed out)
		// returns the first refund; Flutterwave would accept a second one.
		const retry = await flutterwavePaymentProvider.refund(
			{ http: ctx.http, log: ctx.log },
			{
				refundRequestId: "refund-req-1",
				paymentReference: order.paymentReference ?? "",
				amount: 50000,
				currency: "KES",
			},
			{ secretKey: SECRET_KEY },
		);
		expect(flutterwave.refunds).toHaveLength(1);
		expect(retry.providerRefundId).toBe(refund.providerRefundId);

		// A different request for the same amount is a new, legitimate refund.
		await flutterwavePaymentProvider.refund(
			{ http: ctx.http, log: ctx.log },
			{
				refundRequestId: "refund-req-2",
				paymentReference: order.paymentReference ?? "",
				amount: 50000,
				currency: "KES",
			},
			{ secretKey: SECRET_KEY },
		);
		expect(flutterwave.refunds).toHaveLength(2);
	});

	it("sends vendor allocations to Flutterwave as flat subaccounts", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		getCol("vendors").set("v1", vendorRecord("v1"));
		getCol("vendors").set("v2", vendorRecord("v2"));

		const sessionId = "sess_flw_split";
		const cart = ticketCart(sessionId);
		const base = cart.items[0];
		if (!base) throw new Error("ticket cart has no line");
		cart.items = [
			{ ...base, lineId: "l1", vendorId: "v1" },
			{ ...base, lineId: "l2", vendorId: "v2" },
		];
		cart.subtotal = { amount: 300_000, currency: "KES" };
		cart.total = { amount: 300_000, currency: "KES" };

		const res = await startCheckout(ctx, sessionId, cart);
		expect(res.status).toBe(200);
		// 10% default platform fee: each vendor gets 135000 minor = 1350 major.
		expect(flutterwave.getLastInit()?.subaccounts).toEqual([
			{ id: "RS_V1", transaction_charge_type: "flat_subaccount", transaction_charge: 1350 },
			{ id: "RS_V2", transaction_charge_type: "flat_subaccount", transaction_charge: 1350 },
		]);
	});

	it("returns Inline data in embedded mode and still creates the order from the webhook", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx, getCol } = makeContext(
			{
				...flutterwaveSettings,
				"settings:checkoutMode": "embedded",
				"settings:flutterwavePublicKey": PUBLIC_KEY,
			},
			flutterwave.fetch,
		);

		const initRes = await startCheckout(ctx, "sess_flw_onpage_1");
		expect(initRes.status).toBe(200);
		const body = (await initRes.json()) as {
			kind: string;
			client: Record<string, string>;
			returnUrl: string;
			orderDraftId: string;
		};
		expect(body.kind).toBe("on_page");
		expect(body.client.publicKey).toBe(PUBLIC_KEY);
		expect(body.client.txRef).toBe(`dc-${body.orderDraftId}`);
		expect(body.client.amount).toBe("1500");
		expect(body.client.customerEmail).toBe("supporter@example.com");
		expect(body.returnUrl).toContain(`/thank-you/${body.orderDraftId}`);

		// Inline creates the transaction in the browser, so the fake only learns
		// about it when the signed webhook arrives.
		const tx = { id: 777001, amountMinor: 150000, currency: "KES", status: "successful" };
		flutterwave.transactions.set(body.client.txRef ?? "", tx);

		const res = await deliverWebhook(
			ctx,
			chargeCompleted(body.client.txRef ?? "", body.orderDraftId, tx.id),
			SECRET_HASH,
		);
		expect(res.status).toBe(200);
		expect(getCol("orders").size).toBe(1);
	});

	it("refuses embedded checkout when the public key is missing", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx } = makeContext(
			{ ...flutterwaveSettings, "settings:checkoutMode": "embedded" },
			flutterwave.fetch,
		);
		await expect(startCheckout(ctx, "sess_flw_onpage_2")).rejects.toThrow(/needs the public key/);
	});

	it("saves Flutterwave keys through the settings API and refuses a public key as a secret", async () => {
		const { ctx } = makeContext({}, fakeFlutterwave().fetch);
		const routeCtx = {
			request: new Request("http://test/admin/settings", { method: "POST" }),
			input: {
				paymentProvider: "flutterwave",
				flutterwaveSecretKey: SECRET_KEY,
				flutterwaveWebhookSecret: SECRET_HASH,
				flutterwavePublicKey: PUBLIC_KEY,
			},
		} as unknown as import("emdash").RouteContext;
		const res = (await sandbox.routes["admin/settings"].handler(routeCtx, ctx)) as Response;
		expect(res.status).toBe(200);
		expect(await ctx.kv.get("settings:flutterwaveSecretKey")).toBe(SECRET_KEY);
		expect(await ctx.kv.get("settings:flutterwavePublicKey")).toBe(PUBLIC_KEY);

		const bad = (await sandbox.routes["admin/settings"].handler(
			{
				request: new Request("http://test/admin/settings", { method: "POST" }),
				input: { flutterwaveSecretKey: PUBLIC_KEY },
			} as unknown as import("emdash").RouteContext,
			ctx,
		)) as Response;
		expect(bad.status).toBe(400);
	});

	it("moves a pending refund to succeeded on Flutterwave's refund webhook", async () => {
		const flutterwave = fakeFlutterwave();
		const { ctx, getCol } = makeContext(flutterwaveSettings, flutterwave.fetch);
		const initRes = await startCheckout(ctx, "sess_flw_10");
		const { orderDraftId } = (await initRes.json()) as { orderDraftId: string };
		const txRef = String(flutterwave.getLastInit()?.tx_ref);
		const tx = flutterwave.transactions.get(txRef);
		if (!tx) throw new Error("checkout did not register a transaction");
		await deliverWebhook(ctx, chargeCompleted(txRef, orderDraftId, tx.id), SECRET_HASH);
		const order = Array.from(getCol("orders").values())[0] as Order;

		const refundRes = (await sandbox.routes["admin/orders/refund"].handler(
			{
				request: new Request(`http://test/admin/orders/refund?id=${order.id}`, { method: "POST" }),
				input: { amount: 50000, currency: "KES" },
			} as unknown as import("emdash").RouteContext,
			ctx,
		)) as Response;
		expect(refundRes.status).toBe(200);

		// Flutterwave's refund create response says "completed", so core stores
		// the row as succeeded; force it back to pending so the webhook has
		// something to move.
		const refunds = getCol("refunds");
		const refundRow = Array.from(refunds.values())[0] as {
			status: string;
			stripeRefundId: string;
		};
		refundRow.status = "pending";

		const payload = JSON.stringify({
			id: Number(refundRow.stripeRefundId),
			AmountRefunded: 500,
			status: "completed",
			FlwRef: `FLW-MOCK-${tx.id}`,
			TransactionId: tx.id,
			createdAt: "2026-11-19T02:00:00.000Z",
		});
		const res = await deliverWebhook(ctx, payload, SECRET_HASH);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { refund?: string }).refund).toBe("updated");
		expect((Array.from(refunds.values())[0] as { status: string }).status).toBe("succeeded");
	});
});

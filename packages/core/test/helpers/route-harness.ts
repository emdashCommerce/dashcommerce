/**
 * Drive core's real checkout and webhook routes against in-memory KV and
 * storage that enforce the same unique indexes as the database.
 */

import type { PluginContext, RouteContext } from "emdash";
import sandbox from "../../src/sandbox-entry";
import { DASHCOMMERCE_STORAGE } from "../../src/storage-collections";
import type { CartState } from "../../src/types";

type Row = Record<string, unknown>;

export function makeRouteContext(
	initialKv: Record<string, unknown>,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () => {
		throw new Error("No outbound HTTP expected");
	},
) {
	const kvStore = new Map<string, unknown>(Object.entries(initialKv));
	const collections = new Map<string, Map<string, Row>>();
	const getCol = (name: string) => {
		let col = collections.get(name);
		if (!col) {
			col = new Map();
			collections.set(name, col);
		}
		return col;
	};
	const uniqueIndexes = (name: string): string[] =>
		(DASHCOMMERCE_STORAGE as Record<string, { uniqueIndexes?: string[] }>)[name]?.uniqueIndexes ??
		[];

	const storage = new Proxy(
		{},
		{
			get(_target, prop: string) {
				const col = getCol(prop);
				return {
					async get(id: string) {
						return col.get(id) ?? null;
					},
					async put(id: string, data: Row) {
						for (const field of uniqueIndexes(prop)) {
							if (data[field] === undefined || data[field] === null) continue;
							for (const [otherId, other] of col) {
								if (otherId !== id && other[field] === data[field]) {
									throw new Error(`UNIQUE constraint failed: ${prop}.${field}`);
								}
							}
						}
						col.set(id, data);
					},
					async putMany(items: Array<{ id: string; data: Row }>) {
						for (const item of items) col.set(item.id, item.data);
					},
					async delete(id: string) {
						col.delete(id);
					},
					async query(opts?: { where?: Row; limit?: number }) {
						const all = Array.from(col.entries()).map(([id, data]) => ({ id, data }));
						const where = opts?.where;
						const items = where
							? all.filter((item) => Object.entries(where).every(([k, v]) => item.data[k] === v))
							: all;
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

	const logs: Array<{ level: string; msg: string; meta?: unknown }> = [];
	const log =
		(level: string) =>
		(msg: string, meta?: unknown): void => {
			logs.push({ level, msg, meta });
		};

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
		site: { url: "https://shop.example", name: "Shop" },
		url: (p: string) => `https://shop.example${p}`,
		log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
	} as unknown as PluginContext;

	return { ctx, getCol, kvStore, logs };
}

export function ticketCart(sessionId: string): CartState {
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

/** Start hosted checkout for a one-ticket cart; returns the draft id. */
export async function startCheckout(ctx: PluginContext, sessionId: string): Promise<string> {
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
	} as unknown as RouteContext;
	const res = (await sandbox.routes["checkout/create-session"].handler(routeCtx, ctx)) as Response;
	const body = (await res.json()) as { orderDraftId?: string; error?: string };
	if (!body.orderDraftId) throw new Error(`create-session failed: ${body.error ?? res.status}`);
	return body.orderDraftId;
}

export async function deliverWebhook(
	ctx: PluginContext,
	payload: string,
	headers: Record<string, string>,
	url = "http://test/checkout/webhook",
): Promise<Response> {
	const request = new Request(url, { method: "POST", headers, body: payload });
	const routeCtx = { ...ctx, request } as unknown as RouteContext;
	try {
		return (await sandbox.routes["checkout/webhook"].handler(routeCtx, ctx)) as Response;
	} catch (err) {
		// EmDash turns a thrown route error into a 500.
		return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
	}
}

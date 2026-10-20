/**
 * In-memory PluginContext for unit tests. Implements only what Lite uses:
 * kv, settings, storage (orders, stripe_events), content.get, http.fetch,
 * log, site and plugin.
 */

import type { PluginContext } from "emdash/plugin";

type Doc = Record<string, unknown>;

class MemoryCollection {
	rows = new Map<string, { data: Doc; rev: number }>();
	async get(id: string) {
		return structuredClone(this.rows.get(id)?.data ?? null);
	}
	async put(id: string, data: Doc) {
		const prev = this.rows.get(id);
		this.rows.set(id, { data: structuredClone(data), rev: (prev?.rev ?? 0) + 1 });
	}
	async exists(id: string) {
		return this.rows.has(id);
	}
	async getVersioned(id: string) {
		const row = this.rows.get(id);
		return row ? { value: structuredClone(row.data), revision: String(row.rev) } : null;
	}
	async compareAndSet(id: string, expected: string | null, data: Doc) {
		const row = this.rows.get(id);
		const current = row ? String(row.rev) : null;
		if (current !== expected) return { applied: false };
		await this.put(id, data);
		return { applied: true, revision: String(this.rows.get(id)?.rev) };
	}
	async query(
		opts: { where?: Doc; orderBy?: Record<string, "asc" | "desc">; limit?: number } = {},
	) {
		let items = [...this.rows.entries()].map(([id, r]) => ({ id, data: structuredClone(r.data) }));
		if (opts.where) items = items.filter((i) => matches(i.data, opts.where as Doc));
		const [[key, dir] = []] = Object.entries(opts.orderBy ?? {});
		if (key) {
			items.sort((a, b) => {
				const av = String(a.data[key]);
				const bv = String(b.data[key]);
				return dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
			});
		}
		const limit = opts.limit ?? 50;
		return { items: items.slice(0, limit), hasMore: items.length > limit };
	}
	async count(where?: Doc) {
		return [...this.rows.values()].filter((r) => !where || matches(r.data, where)).length;
	}
}

function matches(data: Doc, where: Doc) {
	return Object.entries(where).every(([k, v]) => data[k] === v);
}

export interface FakeProduct {
	id: string;
	status?: string;
	data: Doc;
}

export interface HttpCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

export function makeCtx(
	opts: {
		settings?: Record<string, unknown>;
		products?: FakeProduct[];
		stripe?: (call: HttpCall) => { status: number; body: unknown };
	} = {},
) {
	const kv = new Map<string, unknown>();
	const settings = new Map<string, unknown>(Object.entries(opts.settings ?? {}));
	const orders = new MemoryCollection();
	const stripeEvents = new MemoryCollection();
	const products = new Map((opts.products ?? []).map((p) => [p.id, p]));
	const httpCalls: HttpCall[] = [];
	const logs: Array<{ level: string; msg: string; data?: unknown }> = [];

	const ctx = {
		plugin: { id: "dashcommerce-lite", version: "0.1.0" },
		site: { name: "Test shop", url: "https://shop.example", locale: "en" },
		url: (p: string) => `https://shop.example${p}`,
		kv: {
			get: async (k: string) => structuredClone(kv.get(k) ?? null),
			set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
			delete: async (k: string) => kv.delete(k),
			list: async (prefix = "") =>
				[...kv.entries()]
					.filter(([k]) => k.startsWith(prefix))
					.map(([key, value]) => ({ key, value })),
		},
		settings: {
			get: async (k: string) => settings.get(k) ?? null,
			set: async (k: string, v: unknown) => void settings.set(k, v),
			delete: async (k: string) => settings.delete(k),
			list: async () => [...settings.entries()].map(([key, value]) => ({ key, value })),
		},
		storage: { orders, stripe_events: stripeEvents },
		content: {
			get: async (_collection: string, id: string) => {
				const p = products.get(id);
				if (!p) return null;
				return {
					id: p.id,
					type: "products",
					slug: p.id,
					status: p.status ?? "published",
					locale: "en",
					data: p.data,
					createdAt: "",
					updatedAt: "",
					publishedAt: "",
				};
			},
			list: async () => ({ items: [], hasMore: false }),
		},
		http: {
			fetch: async (url: string, init: RequestInit = {}) => {
				const call: HttpCall = {
					url,
					method: init.method ?? "GET",
					headers: (init.headers ?? {}) as Record<string, string>,
					body: String(init.body ?? ""),
				};
				httpCalls.push(call);
				const res = opts.stripe?.(call) ?? { status: 500, body: { error: { message: "no stub" } } };
				return new Response(JSON.stringify(res.body), { status: res.status });
			},
		},
		log: {
			debug: (msg: string, data?: unknown) => logs.push({ level: "debug", msg, data }),
			info: (msg: string, data?: unknown) => logs.push({ level: "info", msg, data }),
			warn: (msg: string, data?: unknown) => logs.push({ level: "warn", msg, data }),
			error: (msg: string, data?: unknown) => logs.push({ level: "error", msg, data }),
		},
	};

	return {
		ctx: ctx as unknown as PluginContext,
		kv,
		settings,
		orders,
		stripeEvents,
		products,
		httpCalls,
		logs,
	};
}

export function product(id: string, fields: Doc = {}): FakeProduct {
	return {
		id,
		data: {
			title: `Product ${id}`,
			type: "simple",
			prices: JSON.stringify({ USD: { amount: 1500 }, EUR: { amount: 1400 } }),
			sku: id,
			manage_stock: 0,
			stock_status: "instock",
			backorders: "no",
			...fields,
		},
	};
}

/** Sign a payload the way Stripe does (t=..., v1=HMAC-SHA256). */
export async function stripeSignature(payload: string, secret: string, t: number): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
	return `t=${t},v1=${[...sig].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

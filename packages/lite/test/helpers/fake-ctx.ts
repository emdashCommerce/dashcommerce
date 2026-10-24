/**
 * In-memory PluginContext for unit tests. Implements what Lite uses: kv,
 * settings (get/set/delete/list), storage collections declared in
 * emdash-plugin.jsonc, content.get/list, http.fetch, cron, log, site and
 * plugin.
 *
 * Storage follows the host's rules closely enough to catch mistakes:
 * `where` and `orderBy` must use declared indexes, `updateIf` applies
 * `set` and numeric `delta` only when the guard matches, and queries page
 * with a cursor.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginContext } from "emdash/plugin";

type Doc = Record<string, unknown>;

function stripJsonc(src: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < src.length; i += 1) {
		const ch = src[i] as string;
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += src[i + 1] ?? "";
				i += 1;
			} else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i += 1;
			out += "\n";
		} else out += ch;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

export const MANIFEST = JSON.parse(
	stripJsonc(readFileSync(resolve(import.meta.dir, "../../emdash-plugin.jsonc"), "utf8")),
) as {
	slug: string;
	storage: Record<string, { indexes: Array<string | string[]>; uniqueIndexes?: string[] }>;
};

function matchValue(actual: unknown, cond: unknown): boolean {
	if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
		const c = cond as Doc;
		if ("in" in c) return (c.in as unknown[]).includes(actual);
		if ("startsWith" in c)
			return typeof actual === "string" && actual.startsWith(String(c.startsWith));
		if (actual === undefined || actual === null) return false;
		const a = actual as number | string;
		if (c.gt !== undefined && !(a > (c.gt as number | string))) return false;
		if (c.gte !== undefined && !(a >= (c.gte as number | string))) return false;
		if (c.lt !== undefined && !(a < (c.lt as number | string))) return false;
		if (c.lte !== undefined && !(a <= (c.lte as number | string))) return false;
		return true;
	}
	return (actual ?? null) === cond;
}

function matches(data: Doc, where: Doc) {
	return Object.entries(where).every(([k, v]) => matchValue(data[k], v));
}

export class MemoryCollection {
	rows = new Map<string, { data: Doc; rev: number }>();
	indexed: Set<string> | null;
	constructor(
		readonly name: string,
		indexes?: Array<string | string[]>,
	) {
		this.indexed = indexes ? new Set(indexes.flat()) : null;
	}
	private checkFields(fields: string[], what: string) {
		if (!this.indexed) return;
		for (const f of fields) {
			if (!this.indexed.has(f)) {
				throw new Error(`${this.name}: cannot ${what} non-indexed field '${f}'`);
			}
		}
	}
	async get(id: string) {
		return structuredClone(this.rows.get(id)?.data ?? null);
	}
	async getMany(ids: string[]) {
		const out = new Map<string, Doc>();
		for (const id of ids) {
			const row = this.rows.get(id);
			if (row) out.set(id, structuredClone(row.data));
		}
		return out;
	}
	async put(id: string, data: Doc) {
		const prev = this.rows.get(id);
		this.rows.set(id, { data: structuredClone(data), rev: (prev?.rev ?? 0) + 1 });
	}
	async putMany(items: Array<{ id: string; data: Doc }>) {
		for (const i of items) await this.put(i.id, i.data);
	}
	async delete(id: string) {
		return this.rows.delete(id);
	}
	async deleteMany(ids: string[]) {
		let n = 0;
		for (const id of ids) if (this.rows.delete(id)) n += 1;
		return n;
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
	async updateIf(
		id: string,
		args: { where: Doc; set?: Doc; delta?: Record<string, { inc?: number; dec?: number }> },
	) {
		this.checkFields(Object.keys(args.where), "guard on");
		const row = this.rows.get(id);
		if (!row || !matches(row.data, args.where)) return { applied: false };
		const next: Doc = { ...row.data, ...structuredClone(args.set ?? {}) };
		for (const [k, d] of Object.entries(args.delta ?? {})) {
			const base = typeof next[k] === "number" ? (next[k] as number) : 0;
			next[k] = base + (d.inc ?? 0) - (d.dec ?? 0);
		}
		await this.put(id, next);
		return { applied: true, data: structuredClone(next) };
	}
	async query(
		opts: {
			where?: Doc;
			orderBy?: Record<string, "asc" | "desc">;
			limit?: number;
			cursor?: string;
		} = {},
	) {
		this.checkFields(Object.keys(opts.where ?? {}), "query on");
		this.checkFields(Object.keys(opts.orderBy ?? {}), "order by");
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
		const limit = Math.min(opts.limit ?? 50, 100);
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const page = items.slice(start, start + limit);
		const hasMore = items.length > start + limit;
		return { items: page, hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
	}
	async count(where?: Doc) {
		this.checkFields(Object.keys(where ?? {}), "count on");
		return [...this.rows.values()].filter((r) => !where || matches(r.data, where)).length;
	}
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
	const collections = Object.fromEntries(
		Object.entries(MANIFEST.storage).map(([name, cfg]) => [
			name,
			new MemoryCollection(name, [...cfg.indexes, ...(cfg.uniqueIndexes ?? [])]),
		]),
	) as Record<string, MemoryCollection>;
	const products = new Map((opts.products ?? []).map((p) => [p.id, p]));
	const httpCalls: HttpCall[] = [];
	const logs: Array<{ level: string; msg: string; data?: unknown }> = [];
	const cronTasks = new Map<string, { schedule: string }>();
	const calls = { count: 0 };
	const counted = <T extends object>(obj: T): T =>
		new Proxy(obj, {
			get(target, prop, receiver) {
				const v = Reflect.get(target, prop, receiver);
				if (typeof v !== "function") return v;
				return (...args: unknown[]) => {
					calls.count += 1;
					return (v as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});

	const toItem = (p: FakeProduct) => ({
		id: p.id,
		type: "products",
		slug: p.id,
		status: p.status ?? "published",
		locale: "en",
		data: p.data,
		createdAt: "",
		updatedAt: "",
		publishedAt: "",
	});

	const ctx = {
		plugin: { id: MANIFEST.slug, version: "0.2.0" },
		site: { name: "Test shop", url: "https://shop.example", locale: "en" },
		url: (p: string) => `https://shop.example${p}`,
		kv: counted({
			get: async (k: string) => structuredClone(kv.get(k) ?? null),
			set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
			delete: async (k: string) => kv.delete(k),
			list: async (prefix = "") =>
				[...kv.entries()]
					.filter(([k]) => k.startsWith(prefix))
					.map(([key, value]) => ({ key, value })),
		}),
		settings: counted({
			get: async (k: string) => settings.get(k) ?? null,
			set: async (k: string, v: unknown) => void settings.set(k, v),
			delete: async (k: string) => settings.delete(k),
			list: async () => [...settings.entries()].map(([key, value]) => ({ key, value })),
		}),
		storage: Object.fromEntries(Object.entries(collections).map(([k, c]) => [k, counted(c)])),
		content: counted({
			get: async (_collection: string, id: string) => {
				const p = products.get(id);
				return p ? toItem(p) : null;
			},
			list: async (_collection: string, o: { where?: { status?: string } } = {}) => ({
				items: [...products.values()]
					.filter((p) => !o.where?.status || (p.status ?? "published") === o.where.status)
					.map(toItem),
				hasMore: false,
			}),
		}),
		http: counted({
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
		}),
		cron: {
			schedule: async (name: string, o: { schedule: string }) => void cronTasks.set(name, o),
			cancel: async (name: string) => void cronTasks.delete(name),
			list: async () => [],
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
		orders: collections.orders as MemoryCollection,
		carts: collections.carts as MemoryCollection,
		stock: collections.stock as MemoryCollection,
		stockMoves: collections.stock_moves as MemoryCollection,
		stripeEvents: collections.stripe_events as MemoryCollection,
		products,
		httpCalls,
		logs,
		cronTasks,
		/** Bridge calls made so far (kv, settings, storage, content, http). */
		calls,
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

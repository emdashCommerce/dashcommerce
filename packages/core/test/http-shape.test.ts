import { describe, expect, it } from "bun:test";
import { cartRoutes } from "../src/routes/cart";

/**
 * Asserts that cart routes return a real `Response` object with HTTP
 * 4xx on invalid input — not a plain `{ error }` object that emdash's
 * adapter would serialize as `200 OK`.
 *
 * Background: an earlier version of these routes returned
 * `{ error: "..." }` directly. The storefront `fetch()` then saw HTTP
 * 200 and treated every failure as success, silently corrupting the
 * cart UI. This regression test ensures the wire shape never slips.
 */

function stubKv() {
	const store = new Map<string, unknown>();
	return {
		async get(k: string) {
			return store.get(k) ?? null;
		},
		async set(k: string, v: unknown) {
			store.set(k, v);
		},
		async delete(k: string) {
			return store.delete(k);
		},
		async list() {
			return [];
		},
	};
}

function stubCtx() {
	return {
		kv: stubKv(),
		storage: {},
		log: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as import("emdash").PluginContext;
}

function makeRouteCtx(
	pathname: string,
	input: unknown = {},
	method = "POST",
): import("emdash").RouteContext {
	return {
		input,
		request: new Request(`http://test${pathname}`, { method }),
		requestMeta: {
			ip: null,
			userAgent: null,
			referer: null,
			geo: null,
		},
	} as unknown as import("emdash").RouteContext;
}

describe("cart HTTP error shape", () => {
	it("POST /cart/items returns a Response with 400 when productId is missing", async () => {
		const route = cartRoutes["cart/items"];
		const res = await route.handler(
			makeRouteCtx("/cart/items", {}),
			stubCtx(),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toMatch(/productId/i);
	});

	it("POST /cart/currency returns 400 without a currency", async () => {
		const route = cartRoutes["cart/currency"];
		const res = await route.handler(makeRouteCtx("/cart/currency", {}), stubCtx());
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(400);
	});

	it("POST /cart/shipping-address returns 400 without an address", async () => {
		const route = cartRoutes["cart/shipping-address"];
		const res = await route.handler(
			makeRouteCtx("/cart/shipping-address", {}),
			stubCtx(),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(400);
	});
});

import { dirname, join } from "node:path";
import { describe, expect, it, mock } from "bun:test";
import type { PluginContext, PluginRoute, RouteContext } from "emdash";
import { isWebResponse } from "../src/http/web-response";
import { ROUTES, toNativeRoutes } from "../src/sandbox-entry";
import { cartRoutes } from "../src/routes/cart";
import { checkoutRoutes } from "../src/routes/checkout";
import {
	EMDASH_BODY_CONSUMED_ERROR,
	webhookRoutes,
} from "../src/routes/webhook";

type PluginDispatch = (args: {
	runtime: unknown;
	pluginId: string;
	path: string;
	request: Request;
}) => Promise<Response>;

async function loadPatchedPluginDispatch(): Promise<PluginDispatch | null> {
	const resolved = Bun.resolveSync("emdash", import.meta.dir);
	const dist = dirname(resolved);
	const files = [...new Bun.Glob("http-route-dispatch-*.mjs").scanSync({ cwd: dist })];
	if (files[0] === undefined) return null;
	const mod = (await import(join(dist, files[0]))) as Record<string, unknown>;
	const marker = new Response("dispatch-probe", { status: 299 });
	const runtime = {
		getPluginRouteMeta: () => ({ public: true }),
		handlePluginApiRoute: async () => ({ success: true as const, data: marker }),
	};
	for (const value of Object.values(mod)) {
		if (typeof value !== "function") continue;
		try {
			const out = await (value as PluginDispatch)({
				runtime,
				pluginId: "dashcommerce",
				path: "probe",
				request: new Request("http://probe/", { method: "POST" }),
			});
			if (out === marker) return value as PluginDispatch;
		} catch {
			// not dispatchPluginApiRequest
		}
	}
	throw new Error(
		`Found ${files[0]} but could not identify patched dispatchPluginApiRequest`,
	);
}

/**
 * Regression coverage for EmDash 1.2 Response flattening and the
 * maintainer notes on #42:
 * - do not default `response: "raw"` (0.37 typecheck + unpatched 1.x)
 * - duck-type Response instead of `instanceof`
 * - signed webhook through real patched `dispatchPluginApiRequest`
 * - loud failure when the body-clone patch is missing
 */

function dispatchUnpatchedApiSuccess(resultData: unknown): Response {
	return new Response(JSON.stringify({ success: true, data: resultData }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function dispatchWithPatchedAdapter(
	_routeMeta: PluginRoute,
	result: { success: boolean; data?: unknown; error?: unknown; status?: number },
): Response {
	if (!result.success) {
		return new Response(JSON.stringify({ error: result.error }), {
			status: result.status ?? 400,
			headers: { "Content-Type": "application/json" },
		});
	}
	if (isWebResponse(result.data)) return result.data;
	return new Response(JSON.stringify({ success: true, data: result.data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function createMockPluginContext(kvStore: Map<string, unknown> = new Map()): PluginContext {
	return {
		storage: {},
		kv: {
			get: mock(async (key: string) => {
				if (kvStore.has(key)) return kvStore.get(key);
				if (key === "settings:defaultCurrency") return "USD";
				if (key === "settings:taxMode") return "flat";
				if (key === "settings:flatTaxRatePercent") return 0;
				if (key === "settings:enabledCurrencies") return ["USD", "EUR"];
				return null;
			}),
			set: mock(async (key: string, value: unknown) => {
				kvStore.set(key, value);
			}),
			delete: mock(async (key: string) => {
				kvStore.delete(key);
			}),
		},
		log: {
			error: mock(() => {}),
			warn: mock(() => {}),
			info: mock(() => {}),
			debug: mock(() => {}),
		},
	} as unknown as PluginContext;
}

async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	const bytes = new Uint8Array(sig);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

function webhookCtx(): PluginContext {
	const kv = new Map<string, unknown>([
		["settings:stripeWebhookSecret", "whsec_test"],
		["settings:stripeSecretKey", "sk_test_x"],
	]);
	const events = new Set<string>();
	return {
		kv: {
			get: async (k: string) => kv.get(k) ?? null,
			set: async () => {},
			delete: async () => {},
		},
		storage: {
			stripe_events: {
				put: async (_id: string, row: { stripeEventId: string }) => {
					if (events.has(row.stripeEventId)) {
						throw Object.assign(new Error("unique"), { code: "UNIQUE" });
					}
					events.add(row.stripeEventId);
				},
			},
		},
		log: { info() {}, warn() {}, error() {}, debug() {} },
		site: { url: "https://shop.example", name: "Shop" },
		url: (p: string) => `https://shop.example${p}`,
	} as unknown as PluginContext;
}

describe("isWebResponse duck-type", () => {
	it("accepts a real Response", () => {
		expect(isWebResponse(new Response("ok", { status: 201 }))).toBe(true);
	});

	it("accepts a cross-realm Response-like object that fails instanceof", () => {
		const fake = {
			status: 201,
			headers: { get: (name: string) => (name === "Set-Cookie" ? "sid=1" : null) },
			clone() {
				return this;
			},
			async json() {
				return { ok: true };
			},
		};
		expect(fake instanceof Response).toBe(false);
		expect(isWebResponse(fake)).toBe(true);
	});

	it("rejects plain objects that apiSuccess would flatten to {}", () => {
		expect(isWebResponse({})).toBe(false);
		expect(isWebResponse(null)).toBe(false);
		expect(isWebResponse({ status: "201" })).toBe(false);
	});
});

describe("toNativeRoutes", () => {
	it("does not default response: raw (breaks 0.37 types and unpatched 1.x cookies)", () => {
		const nativeRoutes = toNativeRoutes(ROUTES);
		for (const route of Object.values(nativeRoutes)) {
			expect(route.response).toBeUndefined();
			expect(typeof route.handler).toBe("function");
		}
		expect(nativeRoutes.cart?.public).toBe(true);
		expect(nativeRoutes["checkout/webhook"]?.public).toBe(true);
	});

	it("passes a single RouteContext as both handler arguments", async () => {
		let receivedRouteCtx: unknown = null;
		let receivedCtx: unknown = null;
		const native = toNativeRoutes({
			test: {
				public: true,
				handler: async (routeCtx, ctx) => {
					receivedRouteCtx = routeCtx;
					receivedCtx = ctx;
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				},
			},
		});
		const mockCtx = {
			request: new Request("http://localhost/test"),
			input: { foo: "bar" },
			storage: {},
		} as unknown as RouteContext;
		const response = (await native.test.handler(mockCtx)) as Response;
		expect(receivedRouteCtx).toBe(mockCtx);
		expect(receivedCtx).toBe(mockCtx);
		expect(isWebResponse(response)).toBe(true);
	});
});

describe("patched adapter vs unpatched apiSuccess", () => {
	it("reproduces the defect: unpatched dispatch serializes Response to {} and drops Set-Cookie", async () => {
		const original = new Response(JSON.stringify({ cart: { id: "cart_123" } }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Set-Cookie": "dashcommerce_sid=cart_123; Path=/; HttpOnly",
			},
		});
		const broken = dispatchUnpatchedApiSuccess(original);
		expect(await broken.json()).toEqual({ success: true, data: {} });
		expect(broken.headers.get("Set-Cookie")).toBeNull();
	});

	it("preserves body, status, and Set-Cookie for a duck-typed Response", async () => {
		const original = new Response(JSON.stringify({ cart: { id: "cart_abc" } }), {
			status: 201,
			headers: {
				"Content-Type": "application/json",
				"Set-Cookie": "dashcommerce_sid=cart_abc; Path=/; HttpOnly",
			},
		});
		const adapted = dispatchWithPatchedAdapter(toNativeRoutes(ROUTES).cart, {
			success: true,
			data: original,
		});
		expect(adapted).toBe(original);
		expect(adapted.status).toBe(201);
		expect(adapted.headers.get("Set-Cookie")).toContain("dashcommerce_sid=cart_abc");
		expect(await adapted.json()).toEqual({ cart: { id: "cart_abc" } });
	});

	it("preserves HTTP 4xx without flattening to 200", async () => {
		const errorResponse = new Response(JSON.stringify({ error: "productId required" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
		const adapted = dispatchWithPatchedAdapter(toNativeRoutes(ROUTES)["cart/items"], {
			success: true,
			data: errorResponse,
		});
		expect(adapted.status).toBe(400);
		expect(await adapted.json()).toEqual({ error: "productId required" });
	});
});

describe("cart session through the adapter", () => {
	it("initial GET /cart sets dashcommerce_sid and returns a real cart object", async () => {
		const nativeRoutes = toNativeRoutes(cartRoutes);
		const kvStore = new Map<string, unknown>();
		const ctx = createMockPluginContext(kvStore);
		const routeCtx = {
			...ctx,
			request: new Request("http://localhost/_emdash/api/plugins/dashcommerce/cart"),
			input: undefined,
		} as unknown as RouteContext;

		const handlerResult = await nativeRoutes.cart.handler(routeCtx);
		const response = dispatchWithPatchedAdapter(nativeRoutes.cart, {
			success: true,
			data: handlerResult,
		});

		expect(response.status).toBe(200);
		const setCookie = response.headers.get("Set-Cookie");
		expect(setCookie).toContain("dashcommerce_sid=");
		expect(setCookie).toContain("HttpOnly");
		const sessionId = setCookie?.match(/dashcommerce_sid=([^;]+)/)?.[1];
		expect(sessionId).toBeTruthy();
		const body = (await response.json()) as { cart: { sessionId: string; items: unknown[] } };
		expect(body.cart.sessionId).toBe(sessionId);
		expect(body.cart.items).toEqual([]);
	});
});

describe("shared routes through the adapter", () => {
	it("checkout/create-session empty cart stays 400", async () => {
		const nativeRoutes = toNativeRoutes(checkoutRoutes);
		const ctx = createMockPluginContext();
		const routeCtx = {
			...ctx,
			request: new Request(
				"http://localhost/_emdash/api/plugins/dashcommerce/checkout/create-session",
				{ method: "POST" },
			),
			input: {},
		} as unknown as RouteContext;
		const handlerResult = await nativeRoutes["checkout/create-session"].handler(routeCtx);
		const response = dispatchWithPatchedAdapter(nativeRoutes["checkout/create-session"], {
			success: true,
			data: handlerResult,
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("Cart is empty");
	});
});

describe("webhook body-clone patch detection", () => {
	it("fails loudly when the request body was already consumed (unpatched 1.2)", async () => {
		const req = new Request("http://test/checkout/webhook", {
			method: "POST",
			headers: { "stripe-signature": "t=1,v1=abc" },
			body: JSON.stringify({ type: "ping" }),
		});
		await req.json();
		expect(req.bodyUsed).toBe(true);

		const res = await webhookRoutes["checkout/webhook"].handler(
			{ input: { type: "ping" }, request: req } as unknown as RouteContext,
			webhookCtx(),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(EMDASH_BODY_CONSUMED_ERROR);
	});
});

describe("signed webhook through real patched dispatch", () => {
	it("preserves a 200 Response from checkout/webhook when the body-clone patch is present", async () => {
		const dispatch = await loadPatchedPluginDispatch();
		if (!dispatch) return;

		const secret = "whsec_test";
		const payload = JSON.stringify({
			id: "evt_dispatch",
			type: "ping",
			data: { object: {} },
		});
		const timestamp = Math.floor(Date.now() / 1000);
		const sig = await hmacHex(secret, `${timestamp}.${payload}`);
		const ctx = webhookCtx();

		const runtime = {
			getPluginRouteMeta: () => ({ public: true }),
			handlePluginApiRoute: async (
				_pluginId: string,
				_method: string,
				_path: string,
				request: Request,
			) => {
				const input = await request.clone().json().catch(() => undefined);
				const data = await webhookRoutes["checkout/webhook"].handler(
					{ ...ctx, request, input } as unknown as RouteContext,
					ctx,
				);
				return { success: true as const, data };
			},
		};

		const request = new Request("http://test/checkout/webhook", {
			method: "POST",
			headers: { "stripe-signature": `t=${timestamp},v1=${sig}` },
			body: payload,
		});
		const response = await dispatch({
			runtime,
			pluginId: "dashcommerce",
			path: "checkout/webhook",
			request,
		});

		expect(isWebResponse(response)).toBe(true);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { received?: boolean };
		expect(body.received).toBe(true);
		expect(body).not.toEqual({});
	});

	it("returns a duck-typed Response-like that is not instanceof Response", async () => {
		const dispatch = await loadPatchedPluginDispatch();
		if (!dispatch) return;

		const fake = {
			status: 200,
			ok: true,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "set-cookie" ? "dashcommerce_sid=realm; Path=/" : null,
			},
			clone() {
				return this;
			},
			async json() {
				return { received: true, realm: true };
			},
			async text() {
				return JSON.stringify({ received: true, realm: true });
			},
			async arrayBuffer() {
				return new TextEncoder().encode("{}").buffer;
			},
		};
		expect(fake instanceof Response).toBe(false);

		const runtime = {
			getPluginRouteMeta: () => ({ public: true }),
			handlePluginApiRoute: async () => ({ success: true as const, data: fake }),
		};
		const response = await dispatch({
			runtime,
			pluginId: "dashcommerce",
			path: "checkout/webhook",
			request: new Request("http://test/checkout/webhook", { method: "POST" }),
		});
		expect(response).toBe(fake as unknown as Response);
		expect(response.headers.get("Set-Cookie")).toContain("dashcommerce_sid=realm");
	});
});

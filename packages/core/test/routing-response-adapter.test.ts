import { describe, expect, it, mock } from "bun:test";
import type { PluginContext, PluginRoute, RouteContext } from "emdash";
import { toNativeRoutes, ROUTES } from "../src/sandbox-entry";
import { cartRoutes } from "../src/routes/cart";
import { checkoutRoutes } from "../src/routes/checkout";
import { webhookRoutes } from "../src/routes/webhook";

/**
 * Regression test suite for DashCommerce shared routing and response adapter.
 *
 * Verifies:
 * 1. `toNativeRoutes` declares `response: "raw"` for all routes across DashCommerce.
 * 2. Response adapter preserves Web `Response` instances without serializing them
 *    to `{"success":true,"data":{}}` (the unpatched EmDash `apiSuccess` bug).
 * 3. Status codes, headers, and `Set-Cookie` are preserved exactly.
 * 4. Cart session cookies persist through the adapter for multi-step flows.
 * 5. Other routes (checkout, webhooks) behave uniformly through the shared adapter.
 */

// Helper simulating the EmDash route dispatch logic with and without the patch
function dispatchWithUnpatchedApiSuccess(resultData: unknown): Response {
	// Unpatched EmDash default: apiSuccess(result.data) -> JSON.stringify(result.data)
	const serialized = JSON.stringify({ success: true, data: resultData });
	return new Response(serialized, {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function dispatchWithPatchedAdapter(
	routeMeta: PluginRoute,
	result: { success: boolean; data?: unknown; error?: unknown; status?: number },
): Response {
	if (!result.success) {
		return new Response(JSON.stringify({ error: result.error }), {
			status: result.status ?? 400,
			headers: { "Content-Type": "application/json" },
		});
	}
	// DashCommerce patch: let plugin route handlers return a raw Response
	if (result.data instanceof Response) return result.data;

	if (routeMeta.response === "raw") {
		throw new TypeError("Raw plugin routes must return pluginResponse()");
	}
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

describe("Routing Response Adapter & toNativeRoutes", () => {
	it("toNativeRoutes converts all DashCommerce routes with response: 'raw'", () => {
		const nativeRoutes = toNativeRoutes(ROUTES);

		// Every route in DashCommerce must have response: 'raw'
		for (const [name, route] of Object.entries(nativeRoutes)) {
			expect(route.response).toBe("raw");
			expect(typeof route.handler).toBe("function");
		}

		// Spot check key routes across different functional domains
		expect(nativeRoutes["cart"]).toBeDefined();
		expect(nativeRoutes["cart"].response).toBe("raw");
		expect(nativeRoutes["cart"].public).toBe(true);

		expect(nativeRoutes["cart/items"]).toBeDefined();
		expect(nativeRoutes["cart/items"].response).toBe("raw");

		expect(nativeRoutes["checkout/create-session"]).toBeDefined();
		expect(nativeRoutes["checkout/create-session"].response).toBe("raw");

		expect(nativeRoutes["checkout/webhook"]).toBeDefined();
		expect(nativeRoutes["checkout/webhook"].response).toBe("raw");
	});

	it("toNativeRoutes passes single RouteContext as both routeCtx and ctx to handler", async () => {
		let receivedRouteCtx: unknown = null;
		let receivedCtx: unknown = null;

		const dummyRoutes = {
			test: {
				public: true,
				handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
					receivedRouteCtx = routeCtx;
					receivedCtx = ctx;
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
			},
		};

		const native = toNativeRoutes(dummyRoutes);
		const mockCtx = {
			request: new Request("http://localhost/test"),
			input: { foo: "bar" },
			storage: {},
		} as unknown as RouteContext;

		const response = (await native.test.handler(mockCtx)) as Response;
		expect(receivedRouteCtx).toBe(mockCtx);
		expect(receivedCtx).toBe(mockCtx);
		expect(response).toBeInstanceOf(Response);
	});
});

describe("Regression: Defect reproduction vs Patched Adapter", () => {
	it("demonstrates the defect: unpatched apiSuccess converts Response to empty object and drops Set-Cookie", async () => {
		const originalResponse = new Response(JSON.stringify({ cart: { id: "cart_123", items: [] } }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Set-Cookie": "dashcommerce_sid=cart_123; Path=/; HttpOnly",
			},
		});

		// Without the patch, EmDash executes apiSuccess(result.data):
		const brokenResponse = dispatchWithUnpatchedApiSuccess(originalResponse);
		const json = await brokenResponse.json();

		// Bug reproduced: response body serialized as empty object "{}" inside data
		expect(json).toEqual({ success: true, data: {} });
		// Bug reproduced: Set-Cookie is completely missing
		expect(brokenResponse.headers.get("Set-Cookie")).toBeNull();
	});

	it("proves patched adapter preserves Web Response body, status, and headers", async () => {
		const nativeRoutes = toNativeRoutes(ROUTES);
		const originalResponse = new Response(JSON.stringify({ cart: { id: "cart_abc", total: 100 } }), {
			status: 201,
			headers: {
				"Content-Type": "application/json",
				"X-Custom-Header": "dashcommerce-test",
				"Set-Cookie": "dashcommerce_sid=cart_abc; Path=/; HttpOnly",
			},
		});

		const adapted = dispatchWithPatchedAdapter(nativeRoutes["cart"], {
			success: true,
			data: originalResponse,
		});

		expect(adapted).toBe(originalResponse);
		expect(adapted.status).toBe(201);
		expect(adapted.headers.get("X-Custom-Header")).toBe("dashcommerce-test");
		expect(adapted.headers.get("Set-Cookie")).toBe("dashcommerce_sid=cart_abc; Path=/; HttpOnly");

		const body = await adapted.json();
		expect(body).toEqual({ cart: { id: "cart_abc", total: 100 } });
		// Definitely not {"success":true,"data":{}}
		expect(body).not.toHaveProperty("success");
	});

	it("preserves HTTP 4xx error status codes and error bodies without flattening to 200", async () => {
		const nativeRoutes = toNativeRoutes(ROUTES);
		const errorResponse = new Response(JSON.stringify({ error: "productId required" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});

		const adapted = dispatchWithPatchedAdapter(nativeRoutes["cart/items"], {
			success: true,
			data: errorResponse,
		});

		expect(adapted.status).toBe(400);
		const body = await adapted.json();
		expect(body).toEqual({ error: "productId required" });
	});
});

describe("Cart Session Persistence through Adapter", () => {
	it("initial GET /cart sets dashcommerce_sid cookie and returns real cart object", async () => {
		const nativeRoutes = toNativeRoutes(cartRoutes);
		const kvStore = new Map<string, unknown>();
		const ctx = createMockPluginContext(kvStore);

		// Initial request has NO session cookie
		const req = new Request("http://localhost/_emdash/api/plugins/dashcommerce/cart");
		const routeCtx = {
			...ctx,
			request: req,
			input: undefined,
		} as unknown as RouteContext;

		const handlerResult = await nativeRoutes.cart.handler(routeCtx);
		const response = dispatchWithPatchedAdapter(nativeRoutes.cart, {
			success: true,
			data: handlerResult,
		});

		expect(response.status).toBe(200);

		// Set-Cookie must be preserved
		const setCookie = response.headers.get("Set-Cookie");
		expect(setCookie).not.toBeNull();
		expect(setCookie).toContain("dashcommerce_sid=");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("HttpOnly");

		// Extract sessionId
		const sidMatch = setCookie?.match(/dashcommerce_sid=([^;]+)/);
		const sessionId = sidMatch?.[1];
		expect(sessionId).toBeTruthy();

		// Body must be the cart object, NOT {"success":true,"data":{}}
		const body = (await response.json()) as { cart: { sessionId: string; items: unknown[] } };
		expect(body).toHaveProperty("cart");
		expect(body.cart.sessionId).toBe(sessionId);
		expect(body.cart.items).toEqual([]);
	});

	it("subsequent GET /cart with session cookie retains session without re-setting cookie", async () => {
		const nativeRoutes = toNativeRoutes(cartRoutes);
		const kvStore = new Map<string, unknown>();
		const ctx = createMockPluginContext(kvStore);

		const existingSid = "existing_sid_12345";
		// Pre-populate cart store in KV under cart:<sid>
		kvStore.set(`cart:${existingSid}`, {
			sessionId: existingSid,
			currency: "USD",
			items: [{ id: "item_1", name: "Test Product", unitPrice: { amount: 1000, currency: "USD" }, quantity: 1 }],
			coupons: [],
			subtotal: { amount: 1000, currency: "USD" },
			discountTotal: { amount: 0, currency: "USD" },
			total: { amount: 1000, currency: "USD" },
			taxTotal: { amount: 0, currency: "USD" },
			shippingTotal: { amount: 0, currency: "USD" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});

		// Subsequent request WITH Cookie header
		const req = new Request("http://localhost/_emdash/api/plugins/dashcommerce/cart", {
			headers: { Cookie: `dashcommerce_sid=${existingSid}` },
		});
		const routeCtx = {
			...ctx,
			request: req,
			input: undefined,
		} as unknown as RouteContext;

		const handlerResult = await nativeRoutes.cart.handler(routeCtx);
		const response = dispatchWithPatchedAdapter(nativeRoutes.cart, {
			success: true,
			data: handlerResult,
		});

		expect(response.status).toBe(200);
		// When session exists, no new Set-Cookie is issued
		expect(response.headers.get("Set-Cookie")).toBeNull();

		const body = (await response.json()) as { cart: { sessionId: string; items: Array<{ id: string }> } };
		expect(body.cart.sessionId).toBe(existingSid);
		expect(body.cart.items.length).toBe(1);
		expect(body.cart.items[0].id).toBe("item_1");
	});
});

describe("Shared coverage across routes without route-specific workarounds", () => {
	it("checkout/create-session route returns raw Web Response preserved by adapter", async () => {
		const nativeRoutes = toNativeRoutes(checkoutRoutes);
		const ctx = createMockPluginContext();

		// Missing session id / empty cart should 400
		const req = new Request("http://localhost/_emdash/api/plugins/dashcommerce/checkout/create-session", {
			method: "POST",
		});
		const routeCtx = {
			...ctx,
			request: req,
			input: {},
		} as unknown as RouteContext;

		const handlerResult = await nativeRoutes["checkout/create-session"].handler(routeCtx);
		const response = dispatchWithPatchedAdapter(nativeRoutes["checkout/create-session"], {
			success: true,
			data: handlerResult,
		});

		expect(response).toBeInstanceOf(Response);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("Cart is empty");
	});

	it("checkout/webhook route returns raw Web Response preserved by adapter", async () => {
		const nativeRoutes = toNativeRoutes(webhookRoutes);
		const ctx = createMockPluginContext();

		// Request without Stripe signature should 400
		const req = new Request("http://localhost/_emdash/api/plugins/dashcommerce/checkout/webhook", {
			method: "POST",
			body: JSON.stringify({ type: "payment_intent.succeeded" }),
		});
		const routeCtx = {
			...ctx,
			request: req,
			input: { type: "payment_intent.succeeded" },
		} as unknown as RouteContext;

		const handlerResult = await nativeRoutes["checkout/webhook"].handler(routeCtx);
		const response = dispatchWithPatchedAdapter(nativeRoutes["checkout/webhook"], {
			success: true,
			data: handlerResult,
		});

		expect(response).toBeInstanceOf(Response);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("Missing Stripe-Signature");
	});
});

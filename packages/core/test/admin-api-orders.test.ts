import { describe, expect, it, mock } from "bun:test";
import { adminApiRoutes } from "../src/routes/admin-api";
import type { PluginContext, RouteContext } from "emdash";

/**
 * Regression tests for admin API query error handling.
 *
 * Verifies that query routes return structured error responses instead
 * of throwing when the storage layer fails (e.g. version incompatibility,
 * malformed query, or database unavailability).
 */

function createMockContext(overrides?: {
	queryThrows?: Error;
	queryReturns?: { items: unknown[]; cursor: string | null; hasMore: boolean };
}): PluginContext {
	const errorLog = mock(() => {});
	const queryFn = overrides?.queryThrows
		? mock(() => {
				throw overrides.queryThrows;
			})
		: mock(() => Promise.resolve(overrides?.queryReturns ?? { items: [], cursor: null, hasMore: false }));

	return {
		storage: {
			orders: { query: queryFn },
			customers: { query: queryFn },
			subscriptions: { query: queryFn },
			reviews: { query: queryFn },
		},
		log: {
			error: errorLog,
			warn: mock(() => {}),
			info: mock(() => {}),
			debug: mock(() => {}),
		},
	} as unknown as PluginContext;
}

describe("admin orders query error handling", () => {
	it("queryOrders: storage throw → HTTP 500 with error + ctx.log.error called", async () => {
		const storageError = new Error("Storage query failed: version incompatibility");
		const ctx = createMockContext({ queryThrows: storageError });

		const url = new URL("http://localhost/_emdash/api/plugins/dashcommerce/admin/orders");
		const req = new Request(url);
		const routeCtx = { request: req } as RouteContext;

		const handler = adminApiRoutes["admin/orders"].handler;
		const response = await handler(routeCtx, ctx);

		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe("query_failed");
		expect(body.message).toContain("Storage query failed");
		expect(ctx.log.error).toHaveBeenCalledTimes(1);
	});

	it("queryOrders: omits where clause when no filters provided", async () => {
		const ctx = createMockContext();
		const url = new URL("http://localhost/_emdash/api/plugins/dashcommerce/admin/orders");
		const req = new Request(url);
		const routeCtx = { request: req } as RouteContext;

		const handler = adminApiRoutes["admin/orders"].handler;
		await handler(routeCtx, ctx);

		const queryCall = (ctx.storage as { orders: { query: ReturnType<typeof mock> } }).orders.query.mock
			.calls[0][0];
		expect("where" in queryCall).toBe(false);
	});

	it("queryOrders: includes where clause when filters provided", async () => {
		const ctx = createMockContext();
		const url = new URL(
			"http://localhost/_emdash/api/plugins/dashcommerce/admin/orders?status=completed",
		);
		const req = new Request(url);
		const routeCtx = { request: req } as RouteContext;

		const handler = adminApiRoutes["admin/orders"].handler;
		await handler(routeCtx, ctx);

		const queryCall = (ctx.storage as { orders: { query: ReturnType<typeof mock> } }).orders.query.mock
			.calls[0][0];
		expect("where" in queryCall).toBe(true);
		expect(queryCall.where).toEqual({ status: "completed" });
	});

	it("queryCustomers: storage throw → HTTP 500 with error + ctx.log.error called", async () => {
		const storageError = new Error("Database connection lost");
		const ctx = createMockContext({ queryThrows: storageError });

		const url = new URL("http://localhost/_emdash/api/plugins/dashcommerce/admin/customers");
		const req = new Request(url);
		const routeCtx = { request: req } as RouteContext;

		const handler = adminApiRoutes["admin/customers"].handler;
		const response = await handler(routeCtx, ctx);

		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe("query_failed");
		expect(body.message).toContain("Database connection lost");
		expect(ctx.log.error).toHaveBeenCalledTimes(1);
	});

	it("listSubscriptions: storage throw → HTTP 500 with error + ctx.log.error called", async () => {
		const storageError = new Error("Index not found");
		const ctx = createMockContext({ queryThrows: storageError });

		const url = new URL("http://localhost/_emdash/api/plugins/dashcommerce/admin/subscriptions");
		const req = new Request(url);
		const routeCtx = { request: req } as RouteContext;

		const handler = adminApiRoutes["admin/subscriptions"].handler;
		const response = await handler(routeCtx, ctx);

		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe("query_failed");
		expect(body.message).toContain("Index not found");
		expect(ctx.log.error).toHaveBeenCalledTimes(1);
	});

	it("listReviews: storage throw → HTTP 500 with error + ctx.log.error called", async () => {
		const storageError = new Error("Query timeout");
		const ctx = createMockContext({ queryThrows: storageError });

		const url = new URL("http://localhost/_emdash/api/plugins/dashcommerce/admin/reviews");
		const req = new Request(url);
		const routeCtx = { request: req } as RouteContext;

		const handler = adminApiRoutes["admin/reviews"].handler;
		const response = await handler(routeCtx, ctx);

		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe("query_failed");
		expect(body.message).toContain("Query timeout");
		expect(ctx.log.error).toHaveBeenCalledTimes(1);
	});

	it("listReviews: omits where clause when no filters provided", async () => {
		const ctx = createMockContext();
		const url = new URL("http://localhost/_emdash/api/plugins/dashcommerce/admin/reviews");
		const req = new Request(url);
		const routeCtx = { request: req } as RouteContext;

		const handler = adminApiRoutes["admin/reviews"].handler;
		await handler(routeCtx, ctx);

		const queryCall = (ctx.storage as { reviews: { query: ReturnType<typeof mock> } }).reviews.query.mock
			.calls[0][0];
		expect("where" in queryCall).toBe(false);
	});

	it("listReviews: includes where clause when status filter provided", async () => {
		const ctx = createMockContext();
		const url = new URL(
			"http://localhost/_emdash/api/plugins/dashcommerce/admin/reviews?status=approved",
		);
		const req = new Request(url);
		const routeCtx = { request: req } as RouteContext;

		const handler = adminApiRoutes["admin/reviews"].handler;
		await handler(routeCtx, ctx);

		const queryCall = (ctx.storage as { reviews: { query: ReturnType<typeof mock> } }).reviews.query.mock
			.calls[0][0];
		expect("where" in queryCall).toBe(true);
		expect(queryCall.where).toEqual({ status: "approved" });
	});
});

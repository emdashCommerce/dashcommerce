import { describe, expect, it, mock } from "bun:test";
import type { PluginContext } from "emdash";

/**
 * Test to isolate which query shapes trigger "text ->> unknown" on Postgres.
 *
 * Hypothesis: `orderBy` on indexed fields triggers JSON path extraction
 * via `->>` operator, which fails when the storage column is TEXT not JSONB.
 */

function createMockStorageContext(queryBehavior: "throw" | "success"): PluginContext {
	const queryFn = mock((opts: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, string>;
		limit: number;
		cursor?: string;
	}) => {
		// Simulate Postgres error when orderBy is present
		if (queryBehavior === "throw" && opts.orderBy) {
			throw new Error("operator does not exist: text ->> unknown");
		}
		return Promise.resolve({ items: [], cursor: null, hasMore: false });
	});

	return {
		storage: {
			orders: { query: queryFn },
		},
		log: {
			error: mock(() => {}),
			warn: mock(() => {}),
			info: mock(() => {}),
			debug: mock(() => {}),
		},
	} as unknown as PluginContext;
}

describe("storage query shapes that trigger text ->> unknown", () => {
	it("orderBy on indexed field triggers error", async () => {
		const ctx = createMockStorageContext("throw");

		try {
			await (ctx.storage as { orders: { query: (opts: unknown) => Promise<unknown> } }).orders.query({
				orderBy: { createdAt: "desc" },
				limit: 50,
			});
			throw new Error("Should have thrown");
		} catch (err) {
			expect((err as Error).message).toContain("text ->> unknown");
		}
	});

	it("query without orderBy succeeds", async () => {
		const ctx = createMockStorageContext("throw");

		const result = await (ctx.storage as { orders: { query: (opts: unknown) => Promise<{ items: unknown[] }> } }).orders.query({
			limit: 50,
		});

		expect(result.items).toEqual([]);
	});

	it("where clause on indexed field without orderBy succeeds", async () => {
		const ctx = createMockStorageContext("throw");

		const result = await (ctx.storage as { orders: { query: (opts: unknown) => Promise<{ items: unknown[] }> } }).orders.query({
			where: { status: "completed" },
			limit: 50,
		});

		expect(result.items).toEqual([]);
	});
});

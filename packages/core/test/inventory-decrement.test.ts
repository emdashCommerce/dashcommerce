import { describe, expect, it } from "bun:test";
import {
	decrementForOrderItem,
	OversoldError,
} from "../src/inventory/decrement";
import { money } from "../src/money";
import type { OrderItem, ProductFields } from "../src/types";

/**
 * Convert our camelCase ProductFields fixture into the snake_case
 * shape emdash returns from content.get. Keeps the individual `it`
 * blocks concise.
 */
function toSnake(f: ProductFields): Record<string, unknown> {
	return {
		title: f.title,
		type: f.type,
		prices: f.prices,
		sku: f.sku,
		manage_stock: f.manageStock,
		stock_quantity: f.stockQuantity,
		stock_status: f.stockStatus,
		backorders: f.backorders,
		low_stock_threshold: f.lowStockThreshold,
		below_threshold_at: f.belowThresholdAt,
		weight_grams: f.weightGrams,
		tax_class: f.taxClass,
		shipping_class_slug: f.shippingClassSlug,
		featured: f.featured,
		is_downloadable: f.isDownloadable,
		is_virtual: f.isVirtual,
	};
}

/**
 * Minimal stub of PluginContext — only the surfaces decrement hits:
 * ctx.content.get/update, ctx.storage.product_variants.get/put,
 * ctx.storage.inventory_ledger.put.
 *
 * Product `data` uses snake_case field slugs to match emdash's real
 * collection storage — that's what decrement.ts's normalizer reads.
 */
function makeCtx(opts: {
	product?: ProductFields;
	variantStock?: number | null;
}) {
	const productStore = new Map<string, unknown>();
	if (opts.product) {
		productStore.set("p1", {
			id: "p1",
			data: toSnake(opts.product),
		});
	}
	const variantStore = new Map<string, unknown>();
	if (opts.variantStock !== undefined) {
		variantStore.set("v1", {
			id: "v1",
			productId: "p1",
			sku: "SKU-V1",
			prices: {},
			stockQuantity: opts.variantStock,
			weightGrams: null,
			attributes: {},
			isActive: true,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		});
	}
	const ledgerWrites: unknown[] = [];
	const productUpdates: Array<[string, Record<string, unknown>]> = [];

	const ctx = {
		content: {
			async get(collection: string, id: string) {
				if (collection !== "products") return null;
				return productStore.get(id) ?? null;
			},
			async update(
				collection: string,
				id: string,
				patch: Record<string, unknown>,
			) {
				if (collection !== "products") return;
				productUpdates.push([id, patch]);
				const row = productStore.get(id) as { data: ProductFields } | undefined;
				if (row) {
					productStore.set(id, { ...row, data: { ...row.data, ...patch } });
				}
			},
		},
		storage: {
			product_variants: {
				async get(id: string) {
					return variantStore.get(id) ?? null;
				},
				async put(id: string, data: unknown) {
					variantStore.set(id, data);
				},
				async query() {
					return { items: [], hasMore: false };
				},
				async count() {
					return 0;
				},
			},
			inventory_ledger: {
				async put(id: string, data: unknown) {
					ledgerWrites.push({ id, data });
				},
			},
		},
		log: {
			debug() {},
			info() {},
			warn() {},
			error() {},
		},
	} as unknown as import("emdash").PluginContext;

	return { ctx, ledgerWrites, productUpdates, variantStore, productStore };
}

function orderItem(
	overrides: Partial<OrderItem> = {},
): OrderItem {
	return {
		id: "oi1",
		orderId: "o1",
		productId: "p1",
		sku: "SKU",
		name: "Widget",
		quantity: 1,
		unitPrice: money("USD", 1000),
		lineSubtotal: money("USD", 1000),
		discountAmount: money("USD", 0),
		taxAmount: money("USD", 0),
		total: money("USD", 1000),
		isDigital: false,
		...overrides,
	};
}

function baseProduct(overrides: Partial<ProductFields> = {}): ProductFields {
	return {
		title: "Widget",
		type: "simple",
		prices: { USD: { amount: 1000 } },
		sku: "SKU",
		manageStock: true,
		stockQuantity: 5,
		stockStatus: "instock",
		backorders: "no",
		lowStockThreshold: null,
		belowThresholdAt: null,
		weightGrams: null,
		taxClass: "standard",
		shippingClassSlug: null,
		featured: false,
		isDownloadable: false,
		isVirtual: false,
		...overrides,
	};
}

describe("decrementForOrderItem — product path", () => {
	it("decrements stock when sufficient", async () => {
		const { ctx, productUpdates } = makeCtx({
			product: baseProduct({ stockQuantity: 5 }),
		});
		const result = await decrementForOrderItem(ctx, orderItem({ quantity: 2 }));
		expect(result.newStock).toBe(3);
		expect(productUpdates[0]?.[1]).toMatchObject({ stock_quantity: 3 });
	});

	it("throws OversoldError when decrement would go negative", async () => {
		const { ctx } = makeCtx({ product: baseProduct({ stockQuantity: 1 }) });
		await expect(
			decrementForOrderItem(ctx, orderItem({ quantity: 3 })),
		).rejects.toBeInstanceOf(OversoldError);
	});

	it("leaves stock untouched when throwing (no partial write)", async () => {
		const { ctx, productUpdates } = makeCtx({
			product: baseProduct({ stockQuantity: 1 }),
		});
		await expect(
			decrementForOrderItem(ctx, orderItem({ quantity: 3 })),
		).rejects.toBeInstanceOf(OversoldError);
		expect(productUpdates).toHaveLength(0);
	});

	it("skips decrement when product is not tracking stock", async () => {
		const { ctx, productUpdates } = makeCtx({
			product: baseProduct({ manageStock: false, stockQuantity: null }),
		});
		const result = await decrementForOrderItem(ctx, orderItem());
		expect(result.newStock).toBeNull();
		expect(productUpdates).toHaveLength(0);
	});

	it("stamps belowThresholdAt the first time stock dips below threshold", async () => {
		const { ctx, productUpdates } = makeCtx({
			product: baseProduct({
				stockQuantity: 10,
				lowStockThreshold: 5,
				belowThresholdAt: null,
			}),
		});
		const result = await decrementForOrderItem(ctx, orderItem({ quantity: 6 }));
		expect(result.belowThreshold).toBe(true);
		expect(productUpdates[0]?.[1]).toHaveProperty("below_threshold_at");
	});

	it("does NOT re-stamp belowThresholdAt on subsequent decrements", async () => {
		const { ctx, productUpdates } = makeCtx({
			product: baseProduct({
				stockQuantity: 3,
				lowStockThreshold: 5,
				belowThresholdAt: "2026-01-01T00:00:00Z",
			}),
		});
		const result = await decrementForOrderItem(ctx, orderItem({ quantity: 1 }));
		expect(result.belowThreshold).toBe(false);
		expect(productUpdates[0]?.[1]).not.toHaveProperty("below_threshold_at");
	});
});

describe("decrementForOrderItem — variant path", () => {
	it("decrements a variant with sufficient stock", async () => {
		const { ctx, variantStore } = makeCtx({ variantStock: 4 });
		const result = await decrementForOrderItem(
			ctx,
			orderItem({ variantId: "v1", quantity: 2 }),
		);
		expect(result.newStock).toBe(2);
		const v = variantStore.get("v1") as { stockQuantity: number };
		expect(v.stockQuantity).toBe(2);
	});

	it("throws OversoldError for variant going negative", async () => {
		const { ctx } = makeCtx({ variantStock: 1 });
		await expect(
			decrementForOrderItem(ctx, orderItem({ variantId: "v1", quantity: 2 })),
		).rejects.toBeInstanceOf(OversoldError);
	});

	it("skips when variant is not tracking stock", async () => {
		const { ctx, variantStore } = makeCtx({ variantStock: null });
		const result = await decrementForOrderItem(
			ctx,
			orderItem({ variantId: "v1" }),
		);
		expect(result.newStock).toBeNull();
		const v = variantStore.get("v1") as { stockQuantity: unknown };
		expect(v.stockQuantity).toBeNull();
	});
});

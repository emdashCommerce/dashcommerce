/**
 * Plugin-owned stock ledger.
 *
 * Lite reads products with `content:read` only, so it cannot write
 * `stock_quantity` back to the product entry. Instead it keeps a ledger in
 * the `stock` storage collection, one row per product that has
 * `manage_stock` on:
 *
 *   { onHand, baseline }
 *
 * `baseline` is the product's `stock_quantity` when the row was created or
 * last reset. While the product's `stock_quantity` still equals the
 * baseline, the ledger's `onHand` is the available stock. When the merchant
 * edits `stock_quantity` in the content editor, the values differ and the
 * new content value wins: it becomes the available stock, and the row is
 * reset to it on the next stock change. So stock can be set in either
 * place: the product entry (a reset) or Lite's Stock page (an adjustment).
 *
 * Stock is decremented when Stripe confirms payment, and restored when a
 * paid order is fully refunded or cancelled. Decrements use storage
 * `updateIf` with a numeric delta, which the host applies in one SQL
 * statement, so concurrent payments cannot lose updates.
 */

import type { PluginContext } from "emdash/plugin";
import type { LiteOrderItem } from "./orders";
import type { ProductFields } from "./shared";

export interface StockRow {
	productId: string;
	title: string;
	onHand: number;
	baseline: number;
	updatedAt: string;
	lastChange?: { delta: number; reason: StockReason; orderId?: string; at: string };
}

export type StockReason = "sale" | "refund" | "cancel" | "adjust" | "reset" | "seed";

export type StockStore = {
	get(id: string): Promise<StockRow | null>;
	getMany(ids: string[]): Promise<Map<string, StockRow>>;
	put(id: string, data: StockRow): Promise<void>;
	getVersioned(id: string): Promise<{ value: StockRow; revision: string } | null>;
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: StockRow,
	): Promise<{ applied: boolean }>;
	updateIf(
		id: string,
		args: {
			where: Record<string, unknown>;
			set?: Partial<StockRow>;
			delta?: { onHand?: { inc: number } | { dec: number } };
		},
	): Promise<{ applied: true; data: StockRow } | { applied: false }>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: StockRow }>; cursor?: string; hasMore: boolean }>;
	count(where?: Record<string, unknown>): Promise<number>;
};

export function stockStore(ctx: PluginContext): StockStore {
	return (ctx.storage as unknown as { stock: StockStore }).stock;
}

/** True when Lite tracks stock for this product. */
export function isTracked(fields: ProductFields): boolean {
	return fields.manageStock && fields.stockQuantity !== null;
}

/**
 * Available stock for a tracked product, or null when untracked. A ledger
 * row only counts while its baseline matches the product's stock_quantity.
 */
export function availableStock(
	fields: ProductFields,
	row: StockRow | null | undefined,
): number | null {
	if (!isTracked(fields)) return null;
	const content = fields.stockQuantity as number;
	return row && row.baseline === content ? row.onHand : content;
}

export interface StockShortfall {
	productId: string;
	title: string;
	/** How many units were sold beyond the stock on hand. */
	short: number;
}

/**
 * Take the items of a paid order out of stock. Returns lines that went
 * below zero for products that do not allow backorders.
 */
export async function deductStock(
	ctx: PluginContext,
	orderId: string,
	items: LiteOrderItem[],
	now = Date.now(),
): Promise<StockShortfall[]> {
	const tracked = items.filter((i) => i.stock);
	if (tracked.length === 0) return [];
	const store = stockStore(ctx);
	const at = new Date(now).toISOString();
	const rows = await store.getMany(tracked.map((i) => i.productId));
	const shortfalls: StockShortfall[] = [];
	for (const item of tracked) {
		const baseline = item.stock?.baseline as number;
		const lastChange = { delta: -item.quantity, reason: "sale" as const, orderId, at };
		const fresh: StockRow = {
			productId: item.productId,
			title: item.title,
			onHand: baseline - item.quantity,
			baseline,
			updatedAt: at,
			lastChange,
		};
		let row = rows.get(item.productId);
		let onHand: number | undefined;
		if (!row) {
			// First sale of this product: create the row from the product's
			// stock_quantity. A concurrent sale may create it first; then fall
			// through to the delta update below.
			const created = await store.compareAndSet(item.productId, null, fresh);
			if (created.applied) onHand = fresh.onHand;
			else row = (await store.get(item.productId)) ?? undefined;
		}
		if (onHand === undefined && row && row.baseline !== baseline) {
			// The merchant changed stock_quantity on the product since the row
			// was written: the product's value wins.
			await store.put(item.productId, fresh);
			onHand = fresh.onHand;
		}
		if (onHand === undefined) {
			const res = await store.updateIf(item.productId, {
				where: {},
				set: { updatedAt: at, lastChange },
				delta: { onHand: { dec: item.quantity } },
			});
			if (!res.applied) throw new Error("Stock row disappeared during update");
			onHand = res.data.onHand;
		}
		if (onHand < 0 && !item.stock?.backorders) {
			shortfalls.push({
				productId: item.productId,
				title: item.title,
				short: Math.min(item.quantity, -onHand),
			});
		}
	}
	return shortfalls;
}

/** Put the items of a refunded or cancelled order back into stock. */
export async function restoreStock(
	ctx: PluginContext,
	orderId: string,
	items: LiteOrderItem[],
	reason: "refund" | "cancel",
	now = Date.now(),
): Promise<void> {
	const store = stockStore(ctx);
	const at = new Date(now).toISOString();
	for (const item of items) {
		if (!item.stock) continue;
		const res = await store.updateIf(item.productId, {
			where: {},
			set: { updatedAt: at, lastChange: { delta: item.quantity, reason, orderId, at } },
			delta: { onHand: { inc: item.quantity } },
		});
		if (!res.applied) {
			ctx.log.warn("No stock row to restore", { productId: item.productId, orderId });
		}
	}
}

/** Admin: set the on-hand quantity. The baseline is kept, so the ledger stays in charge. */
export async function setOnHand(
	ctx: PluginContext,
	productId: string,
	onHand: number,
	now = Date.now(),
): Promise<StockRow | null> {
	const store = stockStore(ctx);
	const current = await store.get(productId);
	if (!current) return null;
	const at = new Date(now).toISOString();
	const res = await store.updateIf(productId, {
		where: {},
		set: {
			onHand,
			updatedAt: at,
			lastChange: { delta: onHand - current.onHand, reason: "adjust", at },
		},
	});
	return res.applied ? res.data : null;
}

/**
 * Admin: make sure every tracked product has a ledger row, and reset rows
 * whose product stock_quantity changed. Reads up to `limit` products.
 */
export async function syncFromProducts(
	ctx: PluginContext,
	products: Array<{ id: string; fields: ProductFields }>,
	now = Date.now(),
): Promise<{ created: number; reset: number }> {
	const tracked = products.filter((p) => isTracked(p.fields));
	if (tracked.length === 0) return { created: 0, reset: 0 };
	const store = stockStore(ctx);
	const rows = await store.getMany(tracked.map((p) => p.id));
	const at = new Date(now).toISOString();
	let created = 0;
	let reset = 0;
	for (const p of tracked) {
		const qty = p.fields.stockQuantity as number;
		const row = rows.get(p.id);
		if (row && row.baseline === qty) {
			if (row.title !== p.fields.title) {
				await store.updateIf(p.id, { where: {}, set: { title: p.fields.title } });
			}
			continue;
		}
		const next: StockRow = {
			productId: p.id,
			title: p.fields.title,
			onHand: qty,
			baseline: qty,
			updatedAt: at,
			lastChange: { delta: row ? qty - row.onHand : qty, reason: row ? "reset" : "seed", at },
		};
		if (row) {
			await store.put(p.id, next);
			reset += 1;
		} else {
			const res = await store.compareAndSet(p.id, null, next);
			if (res.applied) created += 1;
		}
	}
	return { created, reset };
}

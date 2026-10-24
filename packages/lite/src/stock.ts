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
 * paid order is fully refunded or cancelled. Those order stock changes run
 * in settle.ts: each row write is guarded on the row's `rev` (a
 * compare-and-set in one bridge call), so concurrent payments cannot lose
 * updates, and is recorded per order and product, so retries apply it
 * exactly once.
 */

import type { PluginContext } from "emdash/plugin";
import type { ProductFields } from "./shared";

export interface StockRow {
	productId: string;
	title: string;
	onHand: number;
	baseline: number;
	updatedAt: string;
	lastChange?: { delta: number; reason: StockReason; orderId?: string; at: string };
	/**
	 * Keys of the last few order moves applied to this row
	 * (`${orderId}:sale`, `${orderId}:restore`), written in the same guarded
	 * write as `onHand`. A row is per product, so a key is effectively
	 * per order and product (see settle.ts).
	 */
	moves?: string[];
	/**
	 * Write counter. Every write sets `rev + 1` and is guarded on the `rev`
	 * it read (`updateIf({ where: { rev } })`), which makes each row write a
	 * compare-and-set in one bridge call.
	 */
	rev?: number;
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

/** How many applied move keys a stock row remembers. */
export const ROW_MOVE_MEMORY = 50;

/** Next write counter for a row. */
export const nextRev = (row: StockRow | null | undefined) => (row?.rev ?? 0) + 1;

/**
 * Write `next` over `row` only if nobody wrote the row since it was read:
 * one `updateIf` guarded on `rev` (or on `updatedAt` for a row written
 * before `rev` existed). Returns false on a lost race.
 */
export async function guardedRowWrite(
	store: StockStore,
	row: StockRow,
	next: StockRow,
): Promise<boolean> {
	const where = typeof row.rev === "number" ? { rev: row.rev } : { updatedAt: row.updatedAt };
	const res = await store.updateIf(row.productId, { where, set: next });
	return res.applied;
}

/**
 * Admin: set the on-hand quantity. The baseline is kept, so the ledger
 * stays in charge. Two bridge calls (read, guarded write); a concurrent
 * sale in between makes it fail rather than be overwritten.
 */
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
	const next: StockRow = {
		...current,
		onHand,
		updatedAt: at,
		lastChange: { delta: onHand - current.onHand, reason: "adjust", at },
		rev: nextRev(current),
	};
	return (await guardedRowWrite(store, current, next)) ? next : null;
}

/** Most rows one sync click writes, so the admin request stays in budget. */
export const SYNC_WRITE_LIMIT = 5;

/**
 * Admin: make sure every tracked product has a ledger row, and reset rows
 * whose product stock_quantity changed. Writes at most `maxWrites` rows
 * (one bridge call each, plus one batched read); `remaining` counts the
 * rows still to do, so the page can ask for another click.
 */
export async function syncFromProducts(
	ctx: PluginContext,
	products: Array<{ id: string; fields: ProductFields }>,
	now = Date.now(),
	maxWrites = SYNC_WRITE_LIMIT,
): Promise<{ created: number; reset: number; remaining: number }> {
	const tracked = products.filter((p) => isTracked(p.fields));
	if (tracked.length === 0) return { created: 0, reset: 0, remaining: 0 };
	const store = stockStore(ctx);
	const rows = await store.getMany(tracked.map((p) => p.id));
	const at = new Date(now).toISOString();
	const todo = tracked.filter((p) => {
		const row = rows.get(p.id);
		return !row || row.baseline !== p.fields.stockQuantity || row.title !== p.fields.title;
	});
	let created = 0;
	let reset = 0;
	for (const p of todo.slice(0, maxWrites)) {
		const qty = p.fields.stockQuantity as number;
		const row = rows.get(p.id);
		if (row && row.baseline === qty) {
			await guardedRowWrite(store, row, { ...row, title: p.fields.title, rev: nextRev(row) });
			continue;
		}
		const next: StockRow = {
			productId: p.id,
			title: p.fields.title,
			onHand: qty,
			baseline: qty,
			updatedAt: at,
			lastChange: { delta: row ? qty - row.onHand : qty, reason: row ? "reset" : "seed", at },
			...(row?.moves ? { moves: row.moves } : {}),
			rev: nextRev(row),
		};
		if (row) {
			if (await guardedRowWrite(store, row, next)) reset += 1;
		} else if ((await store.compareAndSet(p.id, null, next)).applied) {
			created += 1;
		}
	}
	return { created, reset, remaining: Math.max(0, todo.length - maxWrites) };
}

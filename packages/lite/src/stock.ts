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
 * paid order is fully refunded or cancelled. Order stock changes use
 * compare-and-set on the row (retried on conflict), so concurrent payments
 * cannot lose updates, and each one is recorded as a `stock_moves` entry
 * keyed `${orderId}:${productId}`, so retries apply it exactly once.
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
	/** Keys of the last few order moves applied to this row (see StockMove). */
	moves?: string[];
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
 * Per-order, per-product stock movement, kept in the `stock_moves`
 * collection under `${orderId}:${productId}`. It makes stock changes
 * idempotent across webhook retries and admin double-clicks:
 *
 *   absent    nothing taken yet
 *   deducted  the sale was taken out of stock (`onHandAfter` keeps the
 *             level right after, so a retry can still report a shortfall)
 *   restored  the sale was put back (refund or cancel)
 *
 * The stock row change and the move are two writes. To make a crash
 * between them safe, the stock row also keeps the last few move keys it
 * applied (`moves`), written in the same compare-and-set as `onHand`. A
 * retry that finds its key there knows the row already has the change and
 * only writes the move.
 */
export interface StockMove {
	orderId: string;
	productId: string;
	quantity: number;
	state: "deducted" | "restored";
	onHandAfter: number;
	deductedAt: string;
	restoredAt?: string;
	reason?: "refund" | "cancel";
}

export type StockMovesStore = {
	getMany(ids: string[]): Promise<Map<string, StockMove>>;
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: StockMove,
	): Promise<{ applied: boolean }>;
	updateIf(
		id: string,
		args: { where: Record<string, unknown>; set?: Partial<StockMove> },
	): Promise<{ applied: true; data: StockMove } | { applied: false }>;
};

export function stockMovesStore(ctx: PluginContext): StockMovesStore {
	return (ctx.storage as unknown as { stock_moves: StockMovesStore }).stock_moves;
}

export const moveId = (orderId: string, productId: string) => `${orderId}:${productId}`;

/** How many applied move keys a stock row remembers. */
export const ROW_MOVE_MEMORY = 50;
const ROW_ATTEMPTS = 8;

/**
 * Apply `delta` to one stock row exactly once for `key`, with
 * compare-and-set. Returns the on-hand level after the change (or the
 * current level when the row already had it), or null when there is no
 * row and `create` is not given.
 */
async function applyRowMove(
	store: StockStore,
	productId: string,
	key: string,
	delta: number,
	change: StockRow["lastChange"],
	at: string,
	create?: { title: string; baseline: number },
): Promise<number | null> {
	for (let i = 0; i < ROW_ATTEMPTS; i += 1) {
		const current = await store.getVersioned(productId);
		const row = current?.value;
		if (row?.moves?.includes(key)) return row.onHand;
		let next: StockRow;
		if (!row || (create && row.baseline !== create.baseline)) {
			// No row yet, or the merchant changed stock_quantity on the product
			// since the row was written: the product's value is the start.
			if (!create) return null;
			next = {
				productId,
				title: create.title,
				onHand: create.baseline + delta,
				baseline: create.baseline,
				updatedAt: at,
				lastChange: change,
				moves: [...(row?.moves ?? []), key].slice(-ROW_MOVE_MEMORY),
			};
		} else {
			next = {
				...row,
				onHand: row.onHand + delta,
				updatedAt: at,
				lastChange: change,
				moves: [...(row.moves ?? []), key].slice(-ROW_MOVE_MEMORY),
			};
		}
		const res = await store.compareAndSet(productId, current?.revision ?? null, next);
		if (res.applied) return next.onHand;
	}
	throw new Error("Stock update conflicted repeatedly");
}

/**
 * Take the items of a paid order out of stock. Idempotent: lines that
 * already have a `deducted` (or `restored`) move are not taken again, so
 * a retried webhook completes only the missing lines. Returns lines that
 * went below zero for products that do not allow backorders.
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
	const movesStore = stockMovesStore(ctx);
	const at = new Date(now).toISOString();
	const moves = await movesStore.getMany(tracked.map((i) => moveId(orderId, i.productId)));
	const shortfalls: StockShortfall[] = [];
	for (const item of tracked) {
		const id = moveId(orderId, item.productId);
		let move = moves.get(id);
		if (!move) {
			const baseline = item.stock?.baseline as number;
			const onHand = (await applyRowMove(
				store,
				item.productId,
				`${orderId}:sale`,
				-item.quantity,
				{ delta: -item.quantity, reason: "sale", orderId, at },
				at,
				{ title: item.title, baseline },
			)) as number;
			move = {
				orderId,
				productId: item.productId,
				quantity: item.quantity,
				state: "deducted",
				onHandAfter: onHand,
				deductedAt: at,
			};
			// A concurrent delivery may have written the move first; the row
			// key above already kept the stock change to one.
			await movesStore.compareAndSet(id, null, move);
		}
		if (move.state === "deducted" && move.onHandAfter < 0 && !item.stock?.backorders) {
			shortfalls.push({
				productId: item.productId,
				title: item.title,
				short: Math.min(item.quantity, -move.onHandAfter),
			});
		}
	}
	return shortfalls;
}

/**
 * Put the items of a refunded or cancelled order back into stock.
 * Idempotent: only lines with a `deducted` move are restored, once. Lines
 * that were never taken (no move) are left alone.
 */
export async function restoreStock(
	ctx: PluginContext,
	orderId: string,
	items: LiteOrderItem[],
	reason: "refund" | "cancel",
	now = Date.now(),
): Promise<void> {
	const tracked = items.filter((i) => i.stock);
	if (tracked.length === 0) return;
	const store = stockStore(ctx);
	const movesStore = stockMovesStore(ctx);
	const at = new Date(now).toISOString();
	const moves = await movesStore.getMany(tracked.map((i) => moveId(orderId, i.productId)));
	for (const item of tracked) {
		const id = moveId(orderId, item.productId);
		const move = moves.get(id);
		if (move?.state !== "deducted") continue;
		const onHand = await applyRowMove(
			store,
			item.productId,
			`${orderId}:restore`,
			move.quantity,
			{ delta: move.quantity, reason, orderId, at },
			at,
		);
		if (onHand === null) {
			ctx.log.warn("No stock row to restore", { productId: item.productId, orderId });
		}
		await movesStore.updateIf(id, {
			where: { state: "deducted" },
			set: { state: "restored", restoredAt: at, reason },
		});
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
			...(row?.moves ? { moves: row.moves } : {}),
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

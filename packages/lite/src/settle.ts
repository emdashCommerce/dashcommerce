/**
 * Stock settle: bring the stock rows in line with an order's `stock`
 * target ("deducted" after payment, "restored" after a full refund or a
 * cancel), a few lines per invocation.
 *
 * Why: a sandboxed invocation gets 10 subrequests on Cloudflare (see
 * budget.ts), and every stock row write is one. A 20-line order cannot
 * take its stock in the webhook request that marks it paid. So the
 * webhook (or refund, or admin cancel) records the target on the order,
 * settles what fits, and schedules a one-shot cron task for the rest.
 * Each task runs one pass in its own invocation and schedules the next
 * until the order is settled.
 *
 * One pass, at most 3 + N bridge calls:
 *   order read (skipped when the caller just wrote it), one batched
 *   `getMany` of the stock rows, one guarded write per line, and one
 *   compare-and-set on the order recording what was applied.
 *
 * Exactly once, across retries, crashes and concurrent passes:
 *   - Each stock row write is an `updateIf` guarded on the row's `rev`
 *     (or a `compareAndSet(id, null)` for a new row), so concurrent sales
 *     never lose an update. A lost race leaves the line for the next pass.
 *   - The same write appends the move key (`${orderId}:sale` or
 *     `${orderId}:restore`) to the row's `moves`. A row is per product,
 *     so the key is per order and product. A pass that finds its key on
 *     the row knows the change is already there and only records it.
 *   - The order keeps `stockMoves[productId]` (the per-order, per-product
 *     ledger). It is written with compare-and-set; on a conflict the pass
 *     re-reads the order and merges what it applied, so facts are never
 *     dropped. `restored` beats `deducted` beats `skipped`.
 *   - While lines are outstanding the order has `stockPending: 1`. When
 *     the last line settles the pass clears it and, for a paid order, sets
 *     `paidEffectsAt` and any stock shortfall in the same write.
 *
 * If a follow-up task is lost, the `stock-sweep` cron task finds orders
 * with `stockPending` and schedules them again.
 */

import type { PluginContext } from "emdash/plugin";
import { log, remaining } from "./budget";
import type { LiteOrder, LiteOrderItem, OrderStockMove } from "./orders";
import { ordersStore } from "./orders";
import {
	guardedRowWrite,
	nextRev,
	ROW_MOVE_MEMORY,
	type StockRow,
	type StockShortfall,
	type StockStore,
	stockStore,
} from "./stock";

export const SETTLE_TASK_PREFIX = "stock-";

export const saleKey = (orderId: string) => `${orderId}:sale`;
export const restoreKey = (orderId: string) => `${orderId}:restore`;

/** Tracked lines whose stock does not match the order's target yet. */
export function pendingLines(order: LiteOrder): LiteOrderItem[] {
	const tracked = order.items.filter((i) => i.stock);
	const moves = order.stockMoves ?? {};
	if (order.stock === "deducted") return tracked.filter((i) => !moves[i.productId]);
	if (order.stock === "restored") {
		return tracked.filter((i) => {
			const m = moves[i.productId];
			return !m || m.state === "deducted";
		});
	}
	return [];
}

const RANK: Record<OrderStockMove["state"], number> = { skipped: 0, deducted: 1, restored: 2 };

function stronger(a: OrderStockMove | undefined, b: OrderStockMove): OrderStockMove {
	if (!a) return b;
	if (RANK[b.state] > RANK[a.state]) return { ...a, ...b };
	return a;
}

/** Lines sold beyond the stock on hand, from the recorded deductions. */
export function shortfallsOf(order: LiteOrder): StockShortfall[] {
	const out: StockShortfall[] = [];
	for (const item of order.items) {
		const m = order.stockMoves?.[item.productId];
		if (!item.stock || !m || m.state !== "deducted" || m.onHandAfter === undefined) continue;
		if (m.onHandAfter < 0 && !item.stock.backorders) {
			out.push({
				productId: item.productId,
				title: item.title,
				short: Math.min(item.quantity, -m.onHandAfter),
			});
		}
	}
	return out;
}

/** True when the order may get `paidEffectsAt` (paid at some point, not set yet). */
function wantsPaidEffects(order: LiteOrder): boolean {
	return Boolean(order.paidAt) && !order.paidEffectsAt;
}

/**
 * Merge `applied` into `base` and derive the bookkeeping fields. Returns
 * null when nothing would change.
 */
export function withSettled(
	base: LiteOrder,
	applied: Map<string, OrderStockMove>,
	now: number,
): LiteOrder | null {
	const moves: Record<string, OrderStockMove> = { ...(base.stockMoves ?? {}) };
	let changed = false;
	for (const [productId, fact] of applied) {
		const merged = stronger(moves[productId], fact);
		if (merged !== moves[productId]) {
			moves[productId] = merged;
			changed = true;
		}
	}
	const { stockPending: _pending, ...rest } = base;
	const next: LiteOrder = { ...rest, ...(changed ? { stockMoves: moves } : {}) };
	const open = pendingLines(next).length > 0;
	if (open) {
		next.stockPending = 1;
	} else if (wantsPaidEffects(next) && next.stock !== "restored") {
		next.paidEffectsAt = new Date(now).toISOString();
		const shortfalls = shortfallsOf(next);
		if (shortfalls.length > 0) {
			next.stockShortfall = shortfalls;
			if (next.status === "processing") next.status = "on-hold";
		}
	} else if (wantsPaidEffects(next)) {
		// Refunded or cancelled before the stock was taken: nothing to take.
		next.paidEffectsAt = new Date(now).toISOString();
	}
	const same =
		!changed &&
		(base.stockPending === 1) === open &&
		base.paidEffectsAt === next.paidEffectsAt &&
		base.status === next.status;
	return same ? null : next;
}

/**
 * Apply one line to its stock row (at most one bridge call). Returns the
 * recorded move, or null when the row write lost a race (the line stays
 * pending for the next pass).
 */
async function applyLine(
	store: StockStore,
	orderId: string,
	order: LiteOrder,
	item: LiteOrderItem,
	row: StockRow | undefined,
	at: string,
): Promise<OrderStockMove | null> {
	const sale = saleKey(orderId);
	const back = restoreKey(orderId);
	const keys = row?.moves ?? [];
	const recorded = order.stockMoves?.[item.productId];

	if (order.stock === "deducted") {
		if (row && keys.includes(sale)) {
			return {
				quantity: item.quantity,
				state: keys.includes(back) ? "restored" : "deducted",
				onHandAfter: row.onHand,
				deductedAt: at,
			};
		}
		const baseline = item.stock?.baseline as number;
		const change = { delta: -item.quantity, reason: "sale" as const, orderId, at };
		let next: StockRow;
		if (!row || row.baseline !== baseline) {
			// No row yet, or the merchant changed stock_quantity on the product
			// since the row was written: the product's value is the start.
			next = {
				productId: item.productId,
				title: item.title,
				onHand: baseline - item.quantity,
				baseline,
				updatedAt: at,
				lastChange: change,
				moves: [...keys, sale].slice(-ROW_MOVE_MEMORY),
				rev: nextRev(row),
			};
		} else {
			next = {
				...row,
				onHand: row.onHand - item.quantity,
				updatedAt: at,
				lastChange: change,
				moves: [...keys, sale].slice(-ROW_MOVE_MEMORY),
				rev: nextRev(row),
			};
		}
		const ok = row
			? await guardedRowWrite(store, row, next)
			: (await store.compareAndSet(item.productId, null, next)).applied;
		if (!ok) return null;
		return { quantity: item.quantity, state: "deducted", onHandAfter: next.onHand, deductedAt: at };
	}

	// Target "restored".
	const reason = order.status === "cancelled" ? "cancel" : "refund";
	const quantity = recorded?.quantity ?? item.quantity;
	const restored: OrderStockMove = {
		...recorded,
		quantity,
		state: "restored",
		restoredAt: at,
		reason,
	};
	if (row && keys.includes(back)) return restored;
	const taken = recorded?.state === "deducted" || (row ? keys.includes(sale) : false);
	if (!taken) return { quantity, state: "skipped" };
	// Taken, but the product's stock row is gone: nothing to put back.
	if (!row) return restored;
	const next: StockRow = {
		...row,
		onHand: row.onHand + quantity,
		updatedAt: at,
		lastChange: { delta: quantity, reason, orderId, at },
		moves: [...keys, back].slice(-ROW_MOVE_MEMORY),
		rev: nextRev(row),
	};
	return (await guardedRowWrite(store, row, next)) ? restored : null;
}

export interface SettleResult {
	/** True when the order needs no more stock work. */
	done: boolean;
	order: LiteOrder | null;
	revision?: string;
}

/**
 * One settle pass for `orderId`, sized to the calls left in this
 * invocation. `reserve` calls are left untouched for the caller (for
 * example the webhook's event record). When lines remain that do not fit,
 * one more call is kept free so the caller can schedule a follow-up task.
 * Pass `current` when the caller just read or wrote the order, to skip a
 * read.
 */
export async function settleStock(
	ctx: PluginContext,
	orderId: string,
	opts: {
		reserve?: number;
		current?: { value: LiteOrder; revision: string } | undefined;
		now?: number;
	} = {},
): Promise<SettleResult> {
	const reserve = opts.reserve ?? 0;
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const orders = ordersStore(ctx);
	const left = () => remaining(ctx) - reserve;

	let current = opts.current;
	if (!current) {
		if (left() < 1) return { done: false, order: null };
		current = (await orders.getVersioned(orderId)) ?? undefined;
		if (!current) return { done: true, order: null };
	}

	const applied = new Map<string, OrderStockMove>();
	const pending = pendingLines(current.value);
	// Calls for row work: one getMany, then one per line, then the order write.
	const free = left() - 2;
	if (pending.length > 0 && free >= 1) {
		const take = pending.length <= free ? pending.length : free - 1;
		const batch = pending.slice(0, Math.max(0, take));
		if (batch.length > 0) {
			const store = stockStore(ctx);
			const rows = await store.getMany(batch.map((i) => i.productId));
			for (const item of batch) {
				if (left() < 2) break;
				const move = await applyLine(
					store,
					orderId,
					current.value,
					item,
					rows.get(item.productId),
					at,
				);
				if (move) applied.set(item.productId, move);
			}
		}
	}

	// Record what was applied. On a conflict, re-read and merge.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const next = withSettled(current.value, applied, now);
		if (!next) {
			return {
				done: pendingLines(current.value).length === 0,
				order: current.value,
				revision: current.revision,
			};
		}
		if (left() < 1) return { done: false, order: current.value };
		const stored = { ...next, updatedAt: at };
		const res = await orders.compareAndSet(orderId, current.revision, stored);
		if (res.applied) {
			return {
				done: pendingLines(stored).length === 0,
				order: stored,
				revision: res.revision,
			};
		}
		// Keep one call for the caller's follow-up schedule.
		if (left() < 3) break;
		const fresh = await orders.getVersioned(orderId);
		if (!fresh) return { done: true, order: null };
		current = fresh;
	}
	if (applied.size > 0) {
		// The row keys still hold these changes; the next pass records them.
		log(ctx, "warn", "Stock settle could not record its changes yet", { orderId });
	}
	return { done: false, order: current.value };
}

/**
 * Schedule a one-shot settle task for the next cron tick (one bridge
 * call). Each pass uses a new task name: EmDash deletes a one-shot task
 * after it runs, which would drop a re-schedule under the same name.
 */
export async function scheduleSettle(
	ctx: PluginContext,
	orderId: string,
	pass: number | "sweep",
	now = Date.now(),
): Promise<boolean> {
	if (!ctx.cron) return false;
	await ctx.cron.schedule(`${SETTLE_TASK_PREFIX}${orderId}-${pass}`, {
		schedule: new Date(now).toISOString(),
		data: { orderId, pass: typeof pass === "number" ? pass : 0 },
	});
	return true;
}

/**
 * Settle what fits now; schedule a follow-up task when lines remain.
 * Returns true when settled. Throws when lines remain and no follow-up
 * could be scheduled, so the caller fails and is retried (Stripe retries
 * the webhook; EmDash retries a failed one-shot task).
 */
export async function settleOrSchedule(
	ctx: PluginContext,
	orderId: string,
	opts: {
		reserve?: number;
		current?: { value: LiteOrder; revision: string } | undefined;
		now?: number;
		pass?: number;
	} = {},
): Promise<SettleResult> {
	const reserve = opts.reserve ?? 0;
	const result = await settleStock(ctx, orderId, opts);
	if (result.done) return result;
	if (remaining(ctx) - reserve >= 1 && (await scheduleSettle(ctx, orderId, (opts.pass ?? 0) + 1))) {
		return result;
	}
	throw new Error("Stock settle incomplete and no follow-up could be scheduled");
}

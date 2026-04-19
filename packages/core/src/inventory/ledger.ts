/**
 * Inventory ledger — an append-only audit log of every stock mutation.
 *
 * Every call to `inventory/decrement.ts` or `inventory/restore.ts` must
 * write a corresponding ledger entry. This makes refund-time restock and
 * admin reconciliation trivial: current stock = Σ ledger.delta.
 *
 * Backed by `ctx.storage.inventory_ledger` (see `storage-collections.ts`).
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import type { InventoryLedgerEntry, InventoryLedgerReason } from "../types";

type LedgerStore = StorageCollection<InventoryLedgerEntry>;

function store(ctx: PluginContext): LedgerStore {
	return (ctx.storage as unknown as { inventory_ledger: LedgerStore }).inventory_ledger;
}

export interface PutLedgerInput {
	productId: string;
	variantId?: string;
	delta: number;
	newStockLevel: number;
	reason: InventoryLedgerReason;
	orderId?: string;
	refundId?: string;
	userId?: string;
	note?: string;
}

export async function putLedgerEntry(
	ctx: PluginContext,
	input: PutLedgerInput,
): Promise<InventoryLedgerEntry> {
	const id = randomId();
	const entry: InventoryLedgerEntry = {
		id,
		productId: input.productId,
		...(input.variantId ? { variantId: input.variantId } : {}),
		delta: input.delta,
		newStockLevel: input.newStockLevel,
		reason: input.reason,
		...(input.orderId ? { orderId: input.orderId } : {}),
		...(input.refundId ? { refundId: input.refundId } : {}),
		...(input.userId ? { userId: input.userId } : {}),
		...(input.note ? { note: input.note } : {}),
		createdAt: new Date().toISOString(),
	};
	await store(ctx).put(id, entry);
	return entry;
}

export async function listLedgerForProduct(
	ctx: PluginContext,
	productId: string,
	opts: { limit?: number; cursor?: string } = {},
): Promise<{ items: InventoryLedgerEntry[]; cursor?: string; hasMore: boolean }> {
	const result = await store(ctx).query({
		where: { productId },
		orderBy: { createdAt: "desc" },
		limit: opts.limit ?? 100,
		cursor: opts.cursor,
	});
	return {
		items: result.items.map((r) => ({ ...(r.data as InventoryLedgerEntry), id: r.id })),
		cursor: result.cursor,
		hasMore: result.hasMore,
	};
}

export async function listLedgerForOrder(
	ctx: PluginContext,
	orderId: string,
): Promise<InventoryLedgerEntry[]> {
	const result = await store(ctx).query({ where: { orderId }, limit: 500 });
	return result.items.map((r) => ({ ...(r.data as InventoryLedgerEntry), id: r.id }));
}

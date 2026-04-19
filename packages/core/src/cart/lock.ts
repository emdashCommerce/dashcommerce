/**
 * Stock soft-locks.
 *
 * When a customer reaches checkout and we create a PaymentIntent, we also
 * reserve inventory for them for 15 minutes via KV-backed locks (keyed
 * `lock:{orderDraftId}`). A subsequent customer seeing the product page
 * should have locked quantity subtracted from the available-to-sell figure.
 *
 * Locks are released on any of:
 *   - `payment_intent.succeeded` webhook → order creation consumes them
 *   - `payment_intent.payment_failed` / `canceled` webhook
 *   - TTL expiry swept by the cron hook (`hooks/cron.ts`, every 5 min)
 */

import type { PluginContext } from "emdash";
import type { StockLock } from "../types";

const LOCK_PREFIX = "lock:";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function lockKey(orderDraftId: string): string {
	return `${LOCK_PREFIX}${orderDraftId}`;
}

export function newLock(
	orderDraftId: string,
	sessionId: string,
	entries: StockLock["entries"],
	opts: { ttlMs?: number; stripePaymentIntentId?: string } = {},
): StockLock {
	const now = Date.now();
	const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
	return {
		orderDraftId,
		sessionId,
		...(opts.stripePaymentIntentId ? { stripePaymentIntentId: opts.stripePaymentIntentId } : {}),
		entries,
		expiresAt: new Date(now + ttl).toISOString(),
		createdAt: new Date(now).toISOString(),
	};
}

export async function createLock(ctx: PluginContext, lock: StockLock): Promise<void> {
	await ctx.kv.set(lockKey(lock.orderDraftId), lock);
}

export async function getLock(
	ctx: PluginContext,
	orderDraftId: string,
): Promise<StockLock | null> {
	return (await ctx.kv.get<StockLock>(lockKey(orderDraftId))) ?? null;
}

export async function deleteLock(ctx: PluginContext, orderDraftId: string): Promise<void> {
	await ctx.kv.delete(lockKey(orderDraftId));
}

/** List all active (non-expired) locks. */
export async function listActiveLocks(ctx: PluginContext): Promise<StockLock[]> {
	const now = Date.now();
	const rows = await ctx.kv.list(LOCK_PREFIX);
	const out: StockLock[] = [];
	for (const row of rows) {
		const lock = row.value as StockLock | null;
		if (!lock) continue;
		if (Date.parse(lock.expiresAt) <= now) continue;
		out.push(lock);
	}
	return out;
}

/**
 * Sum of currently-locked units for a given product (optionally variant).
 * Used by checkout to compute available-to-sell = stock − sumActiveLocks.
 */
export async function sumActiveLocksForProduct(
	ctx: PluginContext,
	productId: string,
	variantId?: string,
): Promise<number> {
	const locks = await listActiveLocks(ctx);
	let total = 0;
	for (const lock of locks) {
		for (const entry of lock.entries) {
			if (entry.productId !== productId) continue;
			if (variantId !== undefined && entry.variantId !== variantId) continue;
			if (variantId === undefined && entry.variantId !== undefined) continue;
			total += entry.quantity;
		}
	}
	return total;
}

/**
 * Release a lock by orderDraftId. Safe to call for missing keys.
 * Returns `true` if a lock was found and deleted.
 */
export async function releaseLock(
	ctx: PluginContext,
	orderDraftId: string,
): Promise<boolean> {
	const existing = await getLock(ctx, orderDraftId);
	if (!existing) return false;
	await deleteLock(ctx, orderDraftId);
	return true;
}

/** Delete any lock whose `expiresAt` is in the past. Returns count swept. */
export async function sweepExpiredLocks(ctx: PluginContext): Promise<number> {
	const now = Date.now();
	const rows = await ctx.kv.list(LOCK_PREFIX);
	let swept = 0;
	for (const row of rows) {
		const lock = row.value as StockLock | null;
		if (!lock) continue;
		if (Date.parse(lock.expiresAt) > now) continue;
		await ctx.kv.delete(row.key);
		swept += 1;
	}
	return swept;
}

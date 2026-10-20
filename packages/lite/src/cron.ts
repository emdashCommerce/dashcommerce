/**
 * Hourly cleanup task.
 *
 * Scheduled with `ctx.cron` when the plugin is installed or activated. Each
 * run does a bounded amount of work so it stays well inside one sandbox
 * invocation:
 *
 *   - deletes up to 100 expired carts (query on `expiresAt` + deleteMany),
 *   - cancels up to 10 orders still pending 25 hours after checkout. A
 *     Checkout Session expires after 24 hours and Stripe then sends
 *     `checkout.session.expired`; this catches orders whose expiry event
 *     never arrived. Each cancel is one guarded `updateIf`, so an order
 *     that was paid in the meantime is left alone.
 *   - deletes up to 100 processed Stripe event ids older than 30 days.
 *     Stripe retries a webhook for at most 3 days, so older ids are no
 *     longer needed for de-duplication.
 */

import type { CronEvent, PluginContext } from "emdash/plugin";
import { cartsStore } from "./cart";
import { ordersStore } from "./orders";

export const CLEANUP_TASK = "cleanup";
export const CLEANUP_SCHEDULE = "@hourly";
export const STALE_ORDER_MS = 25 * 60 * 60 * 1000;
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH = 100;
const ORDER_BATCH = 10;

type EventsStore = {
	query(options: {
		where?: Record<string, unknown>;
		limit?: number;
	}): Promise<{ items: Array<{ id: string }>; hasMore: boolean }>;
	deleteMany(ids: string[]): Promise<number>;
};

export async function scheduleCleanup(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) {
		ctx.log.warn("Cron is not available; expired carts and stale orders are not cleaned up");
		return;
	}
	await ctx.cron.schedule(CLEANUP_TASK, { schedule: CLEANUP_SCHEDULE });
}

export async function handleCron(event: CronEvent, ctx: PluginContext): Promise<void> {
	if (event.name !== CLEANUP_TASK) return;
	const result = await runCleanup(ctx);
	if (result.carts || result.orders || result.events) ctx.log.info("Cleanup done", result);
}

export interface CleanupResult {
	carts: number;
	orders: number;
	events: number;
}

export async function runCleanup(ctx: PluginContext, now = Date.now()): Promise<CleanupResult> {
	const iso = (ms: number) => new Date(ms).toISOString();

	const carts = cartsStore(ctx);
	const expired = await carts.query({ where: { expiresAt: { lt: iso(now) } }, limit: BATCH });
	const cartCount =
		expired.items.length > 0 ? await carts.deleteMany(expired.items.map((c) => c.id)) : 0;

	const orders = ordersStore(ctx);
	const stale = await orders.query({
		where: { status: "pending", createdAt: { lt: iso(now - STALE_ORDER_MS) } },
		limit: ORDER_BATCH,
	});
	let orderCount = 0;
	for (const { id } of stale.items) {
		const res = await orders.updateIf(id, {
			where: { status: "pending", paymentStatus: "pending" },
			set: { status: "cancelled", cancelReason: "stale", updatedAt: iso(now) },
		});
		if (res.applied) orderCount += 1;
	}

	const events = (ctx.storage as unknown as { stripe_events: EventsStore }).stripe_events;
	const old = await events.query({
		where: { createdAt: { lt: iso(now - EVENT_RETENTION_MS) } },
		limit: BATCH,
	});
	const eventCount = old.items.length > 0 ? await events.deleteMany(old.items.map((e) => e.id)) : 0;

	return { carts: cartCount, orders: orderCount, events: eventCount };
}

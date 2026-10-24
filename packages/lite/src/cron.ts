/**
 * Cron tasks. Each run is one sandboxed invocation, so each stays within
 * the 10-subrequest budget (budget.ts).
 *
 * `cleanup` (hourly):
 *   - deletes up to 100 expired carts (query on `expiresAt` + deleteMany),
 *   - cancels up to 3 orders still pending 25 hours after checkout. A
 *     Checkout Session expires after 24 hours and Stripe then sends
 *     `checkout.session.expired`; this catches orders whose expiry event
 *     never arrived. Each cancel is one guarded `updateIf`, so an order
 *     that was paid in the meantime is left alone. Orders waiting for a
 *     delayed payment method (ACH, SEPA debit) are `on-hold`, not
 *     `pending`, so they are never picked up here: Stripe settles those
 *     with `async_payment_succeeded` or `_failed`, which can take days.
 *     More stale orders wait for the next run.
 *   - deletes up to 100 processed Stripe event ids older than 30 days.
 *     Stripe retries a webhook for at most 3 days, so older ids are no
 *     longer needed for de-duplication.
 *
 * `stock-sweep` (every 15 minutes): finds up to 5 orders with
 * `stockPending` (their settle task was lost or kept failing) and
 * schedules a settle task for each.
 *
 * `stock-<orderId>-<pass>` (one-shot): one stock settle pass for an order
 * (settle.ts), scheduling the next pass when lines remain.
 *
 * Scheduling: `plugin:install` and `plugin:activate` schedule the two
 * recurring tasks. EmDash does not run those hooks for a sandboxed plugin
 * loaded from the site config (`sandboxed: [...]` in astro.config), so the
 * storefront cart routes and admin pages also call `ensureCron`, which
 * schedules them once and records `cronVersion` in the plugin settings.
 * They read the settings anyway, so the check costs no extra call.
 */

import type { CronEvent, PluginContext } from "emdash/plugin";
import { log, metered } from "./budget";
import { cartsStore } from "./cart";
import { ordersStore } from "./orders";
import { SETTLE_TASK_PREFIX, scheduleSettle, settleOrSchedule } from "./settle";

export const CLEANUP_TASK = "cleanup";
export const CLEANUP_SCHEDULE = "@hourly";
export const STALE_ORDER_MS = 25 * 60 * 60 * 1000;
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH = 100;
const ORDER_BATCH = 3;

export const SWEEP_TASK = "stock-sweep";
export const SWEEP_SCHEDULE = "*/15 * * * *";
const SWEEP_BATCH = 5;

/** Bump when the set of recurring tasks or their schedules change. */
export const CRON_VERSION = 2;
export const CRON_VERSION_KEY = "cronVersion";

type EventsStore = {
	query(options: {
		where?: Record<string, unknown>;
		limit?: number;
	}): Promise<{ items: Array<{ id: string }>; hasMore: boolean }>;
	deleteMany(ids: string[]): Promise<number>;
};

/** Schedule the recurring tasks (idempotent upserts). Three bridge calls. */
export async function scheduleCleanup(rawCtx: PluginContext): Promise<void> {
	const ctx = metered(rawCtx);
	if (!ctx.cron) {
		log(ctx, "warn", "Cron is not available; expired carts and stale orders are not cleaned up");
		return;
	}
	await ctx.cron.schedule(CLEANUP_TASK, { schedule: CLEANUP_SCHEDULE });
	await ctx.cron.schedule(SWEEP_TASK, { schedule: SWEEP_SCHEDULE });
	await ctx.settings.set(CRON_VERSION_KEY, CRON_VERSION);
}

/**
 * Schedule the recurring tasks if this site has not yet (see the header).
 * `cronVersion` comes from the settings the caller already read. Costs
 * nothing once scheduled, three calls the first time.
 */
export async function ensureCron(ctx: PluginContext, cronVersion: unknown): Promise<void> {
	if (cronVersion === CRON_VERSION || !ctx.cron) return;
	try {
		await scheduleCleanup(ctx);
	} catch (err) {
		log(ctx, "warn", "Could not schedule cleanup tasks", {
			message: err instanceof Error ? err.message : "unknown",
		});
	}
}

export async function handleCron(event: CronEvent, rawCtx: PluginContext): Promise<void> {
	const ctx = metered(rawCtx);
	if (event.name === CLEANUP_TASK) {
		const result = await runCleanup(ctx);
		if (result.carts || result.orders || result.events) log(ctx, "info", "Cleanup done", result);
		return;
	}
	if (event.name === SWEEP_TASK) {
		await runSweep(ctx);
		return;
	}
	if (event.name.startsWith(SETTLE_TASK_PREFIX)) {
		const data = (event.data ?? {}) as { orderId?: unknown; pass?: unknown };
		if (typeof data.orderId !== "string" || data.orderId.length === 0) return;
		const pass = typeof data.pass === "number" && data.pass >= 0 ? data.pass : 0;
		await settleOrSchedule(ctx, data.orderId, { pass });
	}
}

/** Schedule a settle task for orders whose stock work is still open. */
export async function runSweep(ctx: PluginContext, now = Date.now()): Promise<number> {
	const open = await ordersStore(ctx).query({
		where: { stockPending: 1 },
		limit: SWEEP_BATCH,
	});
	let scheduled = 0;
	for (const { id } of open.items) {
		if (await scheduleSettle(ctx, id, "sweep", now)) scheduled += 1;
	}
	return scheduled;
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

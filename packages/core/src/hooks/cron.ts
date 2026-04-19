/**
 * Cron handler — fires on each scheduled task matching our plugin.
 *
 * Tasks registered (via `plugin:install` in phase 17):
 *   - `sweep-stock-locks` every 5 min → release expired cart locks.
 *
 * Future (wired in later phases):
 *   - `dunning-retry` daily → phase 7 subscription retries
 *   - `abandoned-cart-recover` hourly → phase 11
 */

import type { PluginContext } from "emdash";
import { recoverAbandoned } from "../abandoned-cart/recover";
import { sweepExpiredLocks } from "../cart/lock";

/**
 * Minimal CronEvent shape — emdash's runtime type is not re-exported from
 * the package root. We model only the fields we read.
 */
export interface CronEvent {
	name: string;
	data?: Record<string, unknown>;
	scheduledAt: string;
}

export const SWEEP_STOCK_LOCKS = "sweep-stock-locks";
export const ABANDONED_CART_SCAN = "abandoned-cart-scan";

export async function cronHandler(event: CronEvent, ctx: PluginContext): Promise<void> {
	switch (event.name) {
		case SWEEP_STOCK_LOCKS: {
			const swept = await sweepExpiredLocks(ctx);
			if (swept > 0) {
				ctx.log.info(`Swept ${swept} expired stock lock(s)`, { task: event.name });
			}
			return;
		}
		case ABANDONED_CART_SCAN: {
			const { sent, scanned } = await recoverAbandoned(ctx);
			if (sent > 0 || scanned > 0) {
				ctx.log.info(`Abandoned-cart scan: sent ${sent} of ${scanned}`, {
					task: event.name,
				});
			}
			return;
		}
		default:
			ctx.log.debug("Unhandled cron task", { name: event.name });
	}
}

/**
 * Plugin lifecycle hooks — install + activate.
 *
 *   plugin:install — fires once when the plugin is first registered:
 *     - Seed default settings where not already set.
 *     - Create a default shipping zone so the storefront has a rate to
 *       show on first product.
 *     - Rotate signing secrets for download / subscription / cart-restore
 *       tokens (only if missing — never overwrite existing secrets).
 *     - Schedule the cron tasks from phases 6 + 11.
 *
 *   plugin:activate — fires on every server boot. We use it to re-assert
 *     the cron schedule (idempotent) so removing + re-adding the plugin
 *     works without a separate install run.
 */

import type { PluginContext } from "emdash";
import { ABANDONED_CART_SCAN, SWEEP_STOCK_LOCKS } from "./cron";

/** Event is the empty LifecycleEvent. */
export interface LifecycleEvent {}

async function setIfMissing<T>(
	ctx: PluginContext,
	key: string,
	value: T,
): Promise<void> {
	const current = await ctx.kv.get<T>(key);
	if (current === null || current === undefined) {
		await ctx.kv.set(key, value);
	}
}

async function rotateSecretIfMissing(ctx: PluginContext, key: string): Promise<void> {
	const existing = await ctx.kv.get<string>(key);
	if (existing) return;
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	await ctx.kv.set(key, hex);
}

async function ensureDefaultShippingZone(ctx: PluginContext): Promise<void> {
	const zonesStore = (
		ctx.storage as unknown as {
			shipping_zones: {
				query(opts: { limit: number }): Promise<{ items: unknown[] }>;
				put(id: string, data: unknown): Promise<void>;
			};
		}
	).shipping_zones;
	const methodsStore = (
		ctx.storage as unknown as {
			shipping_methods: {
				query(opts: { limit: number }): Promise<{ items: unknown[] }>;
				put(id: string, data: unknown): Promise<void>;
			};
		}
	).shipping_methods;

	const existingZones = await zonesStore.query({ limit: 1 });
	if (existingZones.items.length > 0) return;

	const now = new Date().toISOString();

	// Create a US-wide shipping zone that covers all 50 states + DC.
	// This ensures demo/starter stores can ship to common US addresses
	// like 10001 (New York) and 90210 (California) out of the box.
	await zonesStore.put("us-domestic", {
		id: "us-domestic",
		name: "United States (Domestic)",
		locations: [{ country: "US" }],
		order: 0,
		createdAt: now,
		updatedAt: now,
	});

	// Create a default flat-rate shipping method for the US zone.
	await methodsStore.put("us-flat-rate", {
		id: "us-flat-rate",
		zoneId: "us-domestic",
		title: "Standard Shipping",
		type: "flat_rate",
		enabled: true,
		config: {
			type: "flat_rate",
			amount: { currency: "USD", amount: 500 },
		},
		order: 0,
		createdAt: now,
		updatedAt: now,
	});
}

async function scheduleCronTasks(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) {
		ctx.log.warn("ctx.cron unavailable — skipping schedule registration");
		return;
	}
	try {
		await ctx.cron.schedule(SWEEP_STOCK_LOCKS, { schedule: "*/5 * * * *" });
		await ctx.cron.schedule(ABANDONED_CART_SCAN, { schedule: "0 * * * *" });
	} catch (err) {
		ctx.log.warn("Cron schedule registration failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export async function onInstall(
	_event: LifecycleEvent,
	ctx: PluginContext,
): Promise<void> {
	// Store + currency defaults.
	await setIfMissing(ctx, "settings:defaultCurrency", "USD");
	await setIfMissing(ctx, "settings:enabledCurrencies", ["USD"]);

	// Tax.
	await setIfMissing(ctx, "settings:taxMode", "flat");
	await setIfMissing(ctx, "settings:flatTaxRatePercent", 0);
	await setIfMissing(ctx, "settings:taxAppliesToShipping", false);

	// Inventory + review policy.
	await setIfMissing(ctx, "settings:reviewsRequireApproval", true);
	await setIfMissing(ctx, "settings:reviewsRequirePurchase", false);

	// Downloads.
	await setIfMissing(ctx, "settings:downloadTokenTtlHours", 24);
	await setIfMissing(ctx, "settings:downloadMaxUses", 3);
	await setIfMissing(ctx, "settings:downloadGrantExpiryDays", 30);

	// Abandoned cart.
	await setIfMissing(ctx, "settings:abandonedCartDelayHours", 4);
	await setIfMissing(ctx, "settings:abandonedCartTokenTtlDays", 7);

	// Connect.
	await setIfMissing(ctx, "settings:connectEnabled", false);
	await setIfMissing(ctx, "settings:connectPlatformFeePercent", 10);

	// Signing secrets — 32 bytes hex, rotate only if missing.
	await rotateSecretIfMissing(ctx, "state:downloadSigningSecret");
	await rotateSecretIfMissing(ctx, "state:subscriptionSigningSecret");
	await rotateSecretIfMissing(ctx, "state:cartRestoreSigningSecret");

	// Order number counter — one-time initialization.
	await setIfMissing(ctx, "state:orderNumberCounter", 1000);

	// Seed a default shipping zone so storefront has something to return.
	try {
		await ensureDefaultShippingZone(ctx);
	} catch (err) {
		ctx.log.warn("Default shipping zone seed failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	await scheduleCronTasks(ctx);

	ctx.log.info("DashCommerce installed and ready.");
}

/**
 * Re-assert cron schedules on every activation. Stripe keys and other
 * operator inputs aren't touched here — only the periodic jobs, which
 * are idempotent in emdash's scheduler.
 */
export async function onActivate(
	_event: LifecycleEvent,
	ctx: PluginContext,
): Promise<void> {
	await scheduleCronTasks(ctx);
	ctx.log.debug("DashCommerce activated.");
}

/**
 * Subrequest budget.
 *
 * On Cloudflare, EmDash runs each sandboxed plugin invocation (one route
 * call, one hook, one cron task) in a Worker Loader isolate capped at 10
 * subrequests. Every `ctx.*` call (storage, content, settings, kv, cron,
 * log, http) is an RPC to EmDash's PluginBridge service binding and counts
 * toward that cap, as does each outbound `ctx.http.fetch` (one bridge call
 * each). Going over fails the invocation part-way.
 *
 * Lite allows itself 8 of the 10 (SUBREQUEST_BUDGET), keeping 2 calls of
 * headroom: a real Cloudflare run showed checkout, the webhook, the cron
 * hook and admin cancel each reaching exactly 10, with no room for
 * anything the host might add to an invocation in a later EmDash release.
 *
 * `metered(ctx)` wraps a context so code can ask how many calls are left
 * and size its work to fit: the stock settle pass does as many lines as
 * fit and schedules the rest, and checkout reads as many products as fit
 * and asks the storefront to call again. Every entry point (route, hook,
 * cron task) wraps its context once; wrapping twice is a no-op.
 *
 * `test/unit/bridge-calls.test.ts` counts the calls independently and
 * asserts every path stays within 8.
 */

import type { PluginContext } from "emdash/plugin";

/** EmDash's default `subrequests` limit for sandboxed plugins on Cloudflare. */
export const SANDBOX_SUBREQUEST_CAP = 10;

/**
 * Calls Lite allows itself per invocation: the cap minus 2 calls of
 * headroom, for anything the host adds to an invocation that this meter
 * cannot see, and for drift between EmDash versions.
 */
export const HEADROOM = 2;
export const SUBREQUEST_BUDGET = SANDBOX_SUBREQUEST_CAP - HEADROOM;

interface Meter {
	limit: number;
	used: number;
}

const meters = new WeakMap<object, Meter>();
const COUNTED = new Set<PropertyKey>(["settings", "kv", "content", "http", "cron", "log"]);

function countCalls<T extends object>(target: T, meter: Meter): T {
	return new Proxy(target, {
		get(t, prop, receiver) {
			const value = Reflect.get(t, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				meter.used += 1;
				return (value as (...a: unknown[]) => unknown).apply(t, args);
			};
		},
	});
}

/** Wrap `ctx` so every bridge call is counted against `limit`. */
export function metered(ctx: PluginContext, limit = SUBREQUEST_BUDGET): PluginContext {
	if (meters.has(ctx)) return ctx;
	const meter: Meter = { limit, used: 0 };
	const cache = new Map<PropertyKey, unknown>();
	const collections = new Map<PropertyKey, unknown>();
	const proxy = new Proxy(ctx, {
		get(t, prop, receiver) {
			const value = Reflect.get(t, prop, receiver);
			if (!value || typeof value !== "object") return value;
			if (prop === "storage") {
				if (!cache.has(prop)) {
					cache.set(
						prop,
						new Proxy(value as object, {
							get(s, name, r) {
								const collection = Reflect.get(s, name, r);
								if (!collection || typeof collection !== "object") return collection;
								if (!collections.has(name)) {
									collections.set(name, countCalls(collection as object, meter));
								}
								return collections.get(name);
							},
						}),
					);
				}
				return cache.get(prop);
			}
			if (!COUNTED.has(prop)) return value;
			if (!cache.has(prop)) cache.set(prop, countCalls(value as object, meter));
			return cache.get(prop);
		},
	});
	meters.set(proxy, meter);
	return proxy;
}

/** Calls left in this invocation. Unmetered contexts report the full budget. */
export function remaining(ctx: PluginContext): number {
	const meter = meters.get(ctx);
	return meter ? meter.limit - meter.used : SUBREQUEST_BUDGET;
}

/** Calls made so far in this invocation (0 for an unmetered context). */
export function used(ctx: PluginContext): number {
	return meters.get(ctx)?.used ?? 0;
}

type Level = "debug" | "info" | "warn" | "error";

/**
 * Log through the bridge only when a call is left, so a log line can never
 * push an invocation over the cap. Logging never throws.
 */
export function log(ctx: PluginContext, level: Level, msg: string, data?: unknown): void {
	if (remaining(ctx) <= 0) return;
	try {
		const result = (ctx.log[level] as (m: string, d?: unknown) => unknown)(msg, data);
		if (result && typeof (result as Promise<unknown>).catch === "function") {
			(result as Promise<unknown>).catch(() => {});
		}
	} catch {
		// Logging is best effort.
	}
}

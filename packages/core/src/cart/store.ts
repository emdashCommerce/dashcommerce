/**
 * Cart store — KV-backed, session-keyed.
 *
 * Cart lifecycle:
 *   - `getOrCreate(sessionId, currency)` — idempotent fetch / seed
 *   - `save(cart)` — upsert in KV (prefix `cart:`)
 *   - `clear(sessionId)` — delete on order confirmation or explicit empty
 *
 * Stock lock state lives in a separate KV namespace (`lock:*`) managed by
 * `./lock.ts`.
 */

import type { PluginContext } from "emdash";
import { money, zero } from "../money";
import type { CartState, CurrencyCode } from "../types";

const CART_KEY_PREFIX = "cart:";

export function cartKey(sessionId: string): string {
	return `${CART_KEY_PREFIX}${sessionId}`;
}

export function newCart(sessionId: string, currency: CurrencyCode, userId?: string): CartState {
	const now = new Date().toISOString();
	return {
		sessionId,
		...(userId ? { userId } : {}),
		currency: currency.toUpperCase(),
		items: [],
		coupons: [],
		taxLines: [],
		subtotal: zero(currency),
		discountTotal: zero(currency),
		shippingTotal: zero(currency),
		taxTotal: zero(currency),
		total: zero(currency),
		createdAt: now,
		updatedAt: now,
	};
}

export async function getCart(
	ctx: PluginContext,
	sessionId: string,
): Promise<CartState | null> {
	return (await ctx.kv.get<CartState>(cartKey(sessionId))) ?? null;
}

export async function getOrCreate(
	ctx: PluginContext,
	sessionId: string,
	currency: CurrencyCode,
	userId?: string,
): Promise<CartState> {
	const existing = await getCart(ctx, sessionId);
	if (existing) return existing;
	const cart = newCart(sessionId, currency, userId);
	await save(ctx, cart);
	return cart;
}

export async function save(ctx: PluginContext, cart: CartState): Promise<CartState> {
	const toStore: CartState = { ...cart, updatedAt: new Date().toISOString() };
	await ctx.kv.set(cartKey(cart.sessionId), toStore);
	return toStore;
}

export async function clear(ctx: PluginContext, sessionId: string): Promise<void> {
	await ctx.kv.delete(cartKey(sessionId));
}

/** Sanity check a currency change is legal — only allowed on an empty cart. */
export function canSwitchCurrency(cart: CartState): boolean {
	return cart.items.length === 0;
}

export function switchCurrency(cart: CartState, currency: CurrencyCode): CartState {
	if (!canSwitchCurrency(cart)) {
		throw new Error("Cannot switch currency on a non-empty cart. Clear first.");
	}
	const cc = currency.toUpperCase();
	return {
		...cart,
		currency: cc,
		subtotal: money(cc, 0),
		discountTotal: money(cc, 0),
		shippingTotal: money(cc, 0),
		taxTotal: money(cc, 0),
		total: money(cc, 0),
	};
}

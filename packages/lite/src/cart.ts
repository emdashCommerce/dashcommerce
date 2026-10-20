/**
 * Token cart.
 *
 * Sandboxed routes never see cookies and cannot set them, so the cart is
 * addressed by an opaque token the storefront keeps (for example in
 * localStorage) and sends back in the `X-DashCommerce-Cart` header.
 *
 *   - The token is 32 random bytes, base64url encoded (43 characters).
 *   - KV stores the cart under `cart:<sha256(token)>`, so a KV dump does
 *     not reveal usable tokens. The hash is also the cart id that orders
 *     keep, so the webhook can clear the cart after payment.
 *   - Carts expire 30 days after their last write.
 *
 * Totals use core's `recalculate()`; Lite has no tax, shipping or coupon
 * rules yet, so the totals are subtotal = total.
 */

import type { PluginContext } from "emdash/plugin";
import { type CartState, newCart, recalculate } from "./shared";

type KVAccess = PluginContext["kv"];

export const CART_HEADER = "x-dashcommerce-cart";
export const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_LINES = 20;
export const MAX_QUANTITY = 99;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

interface StoredCart {
	cart: CartState;
	expiresAt: string;
}

export function mintToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isValidToken(token: unknown): token is string {
	return typeof token === "string" && TOKEN_RE.test(token);
}

export function readToken(headers: Record<string, string> | undefined): string | null {
	const value = headers?.[CART_HEADER];
	return isValidToken(value) ? value : null;
}

/** Cart id = hex SHA-256 of the token. */
export async function cartIdForToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	let hex = "";
	for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
	return hex;
}

export function cartKey(cartId: string): string {
	return `cart:${cartId}`;
}

export async function loadCart(
	kv: KVAccess,
	cartId: string,
	now = Date.now(),
): Promise<CartState | null> {
	const stored = await kv.get<StoredCart>(cartKey(cartId));
	if (!stored?.cart) return null;
	if (Date.parse(stored.expiresAt) <= now) {
		await kv.delete(cartKey(cartId));
		return null;
	}
	return stored.cart;
}

export async function saveCart(
	kv: KVAccess,
	cart: CartState,
	now = Date.now(),
): Promise<CartState> {
	const next: CartState = { ...recalculate(cart), updatedAt: new Date(now).toISOString() };
	await kv.set(cartKey(cart.sessionId), {
		cart: next,
		expiresAt: new Date(now + CART_TTL_MS).toISOString(),
	} satisfies StoredCart);
	return next;
}

export function emptyCart(cartId: string, currency: string): CartState {
	return newCart(cartId, currency);
}

/** Shape returned to the storefront. Drops the internal cart id. */
export interface CartView {
	currency: string;
	items: Array<{
		lineId: string;
		productId: string;
		title: string;
		quantity: number;
		unitPrice: { currency: string; amount: number };
		lineSubtotal: { currency: string; amount: number };
	}>;
	itemCount: number;
	subtotal: { currency: string; amount: number };
	total: { currency: string; amount: number };
	updatedAt: string;
}

export function toCartView(cart: CartState): CartView {
	return {
		currency: cart.currency,
		items: cart.items.map((i) => ({
			lineId: i.lineId,
			productId: i.productId,
			title: i.title,
			quantity: i.quantity,
			unitPrice: i.unitPrice,
			lineSubtotal: i.lineSubtotal,
		})),
		itemCount: cart.items.reduce((n, i) => n + i.quantity, 0),
		subtotal: cart.subtotal,
		total: cart.total,
		updatedAt: cart.updatedAt,
	};
}

/**
 * Token cart.
 *
 * Sandboxed routes never see cookies and cannot set them, so the cart is
 * addressed by an opaque token the storefront keeps (for example in
 * localStorage) and sends back in the `X-DashCommerce-Cart` header.
 *
 *   - The token is 32 random bytes, base64url encoded (43 characters).
 *   - The `carts` storage collection keeps the cart under
 *     `sha256(token)`, so reading storage does not reveal usable tokens.
 *     The hash is also the cart id that orders keep, so the webhook can
 *     delete the cart after payment.
 *   - Carts expire 30 days after their last write. The hourly cleanup
 *     task deletes expired carts (indexed on `expiresAt`).
 *
 * Totals use core's `recalculate()` with the store's flat shipping and
 * flat tax settings. With Stripe Tax on, tax is added on the hosted page.
 */

import type { PluginContext } from "emdash/plugin";
import type { LiteConfig } from "./settings";
import { type CartState, money, newCart, recalculate } from "./shared";

export const CART_HEADER = "x-dashcommerce-cart";
export const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_LINES = 20;
export const MAX_QUANTITY = 99;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface StoredCart {
	cart: CartState;
	expiresAt: string;
}

export type CartsStore = {
	get(id: string): Promise<StoredCart | null>;
	put(id: string, data: StoredCart): Promise<void>;
	delete(id: string): Promise<boolean>;
	deleteMany(ids: string[]): Promise<number>;
	query(options: {
		where?: Record<string, unknown>;
		limit?: number;
	}): Promise<{ items: Array<{ id: string; data: StoredCart }>; hasMore: boolean }>;
};

export function cartsStore(ctx: PluginContext): CartsStore {
	return (ctx.storage as unknown as { carts: CartsStore }).carts;
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

/** Hex SHA-256 of a string. The cart id is the hash of the token. */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	let hex = "";
	for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
	return hex;
}

export const cartIdForToken = sha256Hex;

export async function loadCart(
	ctx: PluginContext,
	cartId: string,
	now = Date.now(),
): Promise<CartState | null> {
	const stored = await cartsStore(ctx).get(cartId);
	if (!stored?.cart) return null;
	if (Date.parse(stored.expiresAt) <= now) {
		await cartsStore(ctx).delete(cartId);
		return null;
	}
	return stored.cart;
}

/**
 * Totals for a cart under the current settings. Flat shipping applies when
 * at least one line is physical. Flat tax applies to the item subtotal.
 */
export function priceCart(cart: CartState, config: LiteConfig): CartState {
	const physical = cart.items.some((i) => !i.isDigital);
	const { shippingMethod: _previous, ...rest } = cart;
	const next: CartState =
		physical && config.flatShipping > 0
			? {
					...rest,
					shippingMethod: {
						id: "flat",
						label: "Shipping",
						amount: money(cart.currency, config.flatShipping),
					},
				}
			: rest;
	return recalculate(
		next,
		config.automaticTax
			? { taxMode: "stripe_tax" }
			: { taxMode: "flat", flatTaxPercent: config.flatTaxPercent },
	);
}

export async function saveCart(
	ctx: PluginContext,
	cart: CartState,
	config: LiteConfig,
	now = Date.now(),
): Promise<CartState> {
	const next: CartState = { ...priceCart(cart, config), updatedAt: new Date(now).toISOString() };
	await cartsStore(ctx).put(cart.sessionId, {
		cart: next,
		expiresAt: new Date(now + CART_TTL_MS).toISOString(),
	});
	return next;
}

export function emptyCart(cartId: string, currency: string): CartState {
	return newCart(cartId, currency);
}

type MoneyView = { currency: string; amount: number };

/** Shape returned to the storefront. Drops the internal cart id. */
export interface CartView {
	currency: string;
	items: Array<{
		lineId: string;
		productId: string;
		title: string;
		quantity: number;
		unitPrice: MoneyView;
		lineSubtotal: MoneyView;
	}>;
	itemCount: number;
	subtotal: MoneyView;
	shippingTotal: MoneyView;
	taxTotal: MoneyView;
	total: MoneyView;
	/** True when Stripe Tax adds tax on the Checkout page, so `total` excludes tax. */
	taxAtCheckout: boolean;
	updatedAt: string;
}

export function toCartView(cart: CartState, config?: Pick<LiteConfig, "automaticTax">): CartView {
	const zero = { currency: cart.currency, amount: 0 };
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
		shippingTotal: cart.shippingTotal ?? zero,
		taxTotal: cart.taxTotal ?? zero,
		total: cart.total,
		taxAtCheckout: Boolean(config?.automaticTax),
		updatedAt: cart.updatedAt,
	};
}

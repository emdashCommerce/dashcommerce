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
 * A coupon on the cart (coupons.ts) comes off the item subtotal before
 * tax, or removes the flat shipping.
 */

import type { PluginContext } from "emdash/plugin";
import { type CartCoupon, discountFor, type LiteCart } from "./coupons";
import type { LiteConfig } from "./settings";
import { add, money, newCart, type ProductFields, recalculate } from "./shared";

export const CART_HEADER = "x-dashcommerce-cart";
export const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_LINES = 20;
export const MAX_QUANTITY = 99;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface StoredCart {
	cart: LiteCart;
	expiresAt: string;
	/**
	 * Products checkout already read from content for this cart version,
	 * when a large cart needed more than one checkout request (see
	 * checkout.ts). Trusted for `PREP_TTL_MS` and only for `cartUpdatedAt`.
	 */
	checkoutPrep?: {
		cartUpdatedAt: string;
		products: Record<string, { fields: ProductFields; at: string }>;
		/** The cart's coupon as checkout last read it, trusted like `products`. */
		coupon?: { snapshot: CartCoupon; at: string };
	};
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
): Promise<LiteCart | null> {
	return (await loadStoredCart(ctx, cartId, now))?.cart ?? null;
}

/** The stored cart record (cart plus checkout prep), or null when absent or expired. */
export async function loadStoredCart(
	ctx: PluginContext,
	cartId: string,
	now = Date.now(),
): Promise<StoredCart | null> {
	const stored = await cartsStore(ctx).get(cartId);
	if (!stored?.cart) return null;
	if (Date.parse(stored.expiresAt) <= now) {
		await cartsStore(ctx).delete(cartId);
		return null;
	}
	return stored;
}

/**
 * Totals for a cart under the current settings. Flat shipping applies when
 * at least one line is physical, unless a free-shipping coupon applies.
 * The coupon discount comes off the item subtotal, and flat tax applies to
 * what is left.
 */
export function priceCart(cart: LiteCart, config: LiteConfig): LiteCart {
	const { shippingMethod: _previous, ...rest } = cart;
	const subtotal = cart.items.reduce(
		(sum, i) => add(sum, money(cart.currency, i.unitPrice.amount * i.quantity)),
		money(cart.currency, 0),
	);
	const applied = cart.coupon ? discountFor(cart.coupon, { ...cart, subtotal }) : null;
	const physical = cart.items.some((i) => !i.isDigital);
	const next: LiteCart = {
		...rest,
		coupons: applied ? [applied] : [],
		...(physical && config.flatShipping > 0 && !applied?.freeShipping
			? {
					shippingMethod: {
						id: "flat",
						label: "Shipping",
						amount: money(cart.currency, config.flatShipping),
					},
				}
			: {}),
	};
	return recalculate(
		next,
		config.automaticTax
			? { taxMode: "stripe_tax" }
			: { taxMode: "flat", flatTaxPercent: config.flatTaxPercent },
	) as LiteCart;
}

export async function saveCart(
	ctx: PluginContext,
	cart: LiteCart,
	config: LiteConfig,
	now = Date.now(),
): Promise<LiteCart> {
	// `updatedAt` strictly increases on every write: checkout derives its
	// order id and Stripe idempotency key from it (see checkout.ts).
	const previous = Date.parse(cart.updatedAt);
	const at = Number.isFinite(previous) && previous >= now ? previous + 1 : now;
	const next: LiteCart = { ...priceCart(cart, config), updatedAt: new Date(at).toISOString() };
	await cartsStore(ctx).put(cart.sessionId, {
		cart: next,
		expiresAt: new Date(at + CART_TTL_MS).toISOString(),
	});
	return next;
}

export function emptyCart(cartId: string, currency: string): LiteCart {
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
	/** Coupon discount on the item subtotal. */
	discountTotal: MoneyView;
	/**
	 * The coupon on the cart. `applied` is false while the cart does not
	 * qualify yet (below the coupon's minimum).
	 */
	coupon: {
		code: string;
		type: CartCoupon["type"];
		value: number;
		applied: boolean;
		freeShipping: boolean;
		minSubtotal: MoneyView | null;
	} | null;
	shippingTotal: MoneyView;
	taxTotal: MoneyView;
	total: MoneyView;
	/** True when Stripe Tax adds tax on the Checkout page, so `total` excludes tax. */
	taxAtCheckout: boolean;
	updatedAt: string;
}

export function toCartView(cart: LiteCart, config?: Pick<LiteConfig, "automaticTax">): CartView {
	const zero = { currency: cart.currency, amount: 0 };
	const applied = cart.coupon ? cart.coupons.find((c) => c.code === cart.coupon?.code) : undefined;
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
		discountTotal: cart.discountTotal ?? zero,
		coupon: cart.coupon
			? {
					code: cart.coupon.code,
					type: cart.coupon.type,
					value: cart.coupon.value,
					applied: Boolean(applied),
					freeShipping: Boolean(applied?.freeShipping),
					minSubtotal: cart.coupon.minSubtotal
						? { currency: cart.coupon.currency, amount: cart.coupon.minSubtotal }
						: null,
				}
			: null,
		shippingTotal: cart.shippingTotal ?? zero,
		taxTotal: cart.taxTotal ?? zero,
		total: cart.total,
		taxAtCheckout: Boolean(config?.automaticTax),
		updatedAt: cart.updatedAt,
	};
}

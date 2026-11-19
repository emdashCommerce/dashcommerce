/**
 * Coupons.
 *
 * A coupon is a code the shopper types on the cart. Lite supports the
 * cart-wide kinds: a percentage off the item subtotal, a fixed amount off
 * the item subtotal, or free shipping. Each coupon can have a minimum
 * subtotal, a start and end date (UTC days) and a limit on how many paid
 * orders may use it. One coupon per cart.
 *
 * Coupons live in the `coupons` storage collection, keyed by the
 * upper-cased code. The rules are core's (`coupons/validate.ts`): Lite maps
 * its coupon onto core's `Coupon` and calls `validateCoupon` and
 * `resolveDiscount`, so a code means the same thing in both plugins.
 *
 * Uses are not counted on the coupon. They are the paid orders that carry
 * the code (`orders.couponCode`, indexed), counted with one `count` call
 * when the coupon has a limit. Nothing has to be written when an order is
 * paid, so the webhook's call budget does not change, and a fully refunded
 * order gives its use back. The limit is checked when the code is applied
 * and again at checkout; two shoppers paying at the same moment can both
 * get the last use.
 *
 * The cart keeps a copy of the rules it needs to price itself
 * (`CartCoupon`), so changing the cart does not read the coupon again.
 * Checkout reads the coupon again and drops it if it is no longer valid.
 */

import type { PluginContext } from "emdash/plugin";
import { ordersStore } from "./orders";
import {
	type AppliedCoupon,
	type CartState,
	type Coupon,
	money,
	resolveDiscount,
	validateCoupon,
} from "./shared";

export type CouponType = "percent" | "fixed" | "free_shipping";

export const COUPON_TYPES: CouponType[] = ["percent", "fixed", "free_shipping"];

export interface LiteCoupon {
	/** Upper case, also the storage id. */
	code: string;
	type: CouponType;
	/** percent: 1 to 100. fixed: minor units of `currency`. free_shipping: 0. */
	value: number;
	/** Store currency when the coupon was saved. A fixed coupon only applies in it. */
	currency: string;
	active: boolean;
	/** Item subtotal the cart needs, minor units. */
	minSubtotal?: number;
	/** Paid orders that may use the code. */
	usageLimit?: number;
	/** ISO timestamps, from the admin's UTC dates. */
	startsAt?: string;
	endsAt?: string;
	createdAt: string;
	updatedAt: string;
}

/** The rules a cart keeps to price itself without reading storage. */
export interface CartCoupon {
	code: string;
	type: CouponType;
	value: number;
	currency: string;
	minSubtotal?: number;
}

/** Core's CartState plus the coupon Lite keeps on it. */
export type LiteCart = CartState & { coupon?: CartCoupon };

/** Payment states whose orders count as a use of their coupon. */
export const USED_PAYMENT_STATUSES = ["paid", "partially-refunded"];

const CODE_RE = /^[A-Z0-9_-]{2,32}$/;

/** " summer-10 " -> "SUMMER-10". Undefined when not a valid code. */
export function normalizeCode(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const code = value.trim().toUpperCase();
	return CODE_RE.test(code) ? code : undefined;
}

export type CouponsStore = {
	get(id: string): Promise<LiteCoupon | null>;
	put(id: string, data: LiteCoupon): Promise<void>;
	delete(id: string): Promise<boolean>;
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: LiteCoupon,
	): Promise<{ applied: true; revision: string } | { applied: false }>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{
		items: Array<{ id: string; data: LiteCoupon }>;
		cursor?: string;
		hasMore: boolean;
	}>;
};

export function couponsStore(ctx: PluginContext): CouponsStore {
	return (ctx.storage as unknown as { coupons: CouponsStore }).coupons;
}

/** Paid orders that used the code. One bridge call. */
export async function countUses(ctx: PluginContext, code: string): Promise<number> {
	return ordersStore(ctx).count({
		couponCode: code,
		paymentStatus: { in: USED_PAYMENT_STATUSES },
	});
}

export function toCartCoupon(c: LiteCoupon): CartCoupon {
	return {
		code: c.code,
		type: c.type,
		value: c.value,
		currency: c.currency,
		...(c.minSubtotal ? { minSubtotal: c.minSubtotal } : {}),
	};
}

const CORE_TYPE = {
	percent: "percent_cart",
	fixed: "fixed_cart",
	free_shipping: "free_shipping",
} as const;

/** Lite's coupon as core's `Coupon`, so core's rules apply. */
export function toCoreCoupon(c: LiteCoupon | CartCoupon, usageCount = 0): Coupon {
	const full = c as Partial<LiteCoupon>;
	return {
		id: c.code,
		code: c.code,
		discountType: CORE_TYPE[c.type],
		discountValue: c.value,
		currency: c.currency,
		status: full.active === false ? "inactive" : "active",
		...(full.startsAt ? { startsAt: full.startsAt } : {}),
		...(full.endsAt ? { endsAt: full.endsAt } : {}),
		...(c.minSubtotal ? { minAmount: money(c.currency, c.minSubtotal) } : {}),
		...(full.usageLimit ? { usageLimit: full.usageLimit } : {}),
		usageCount,
		excludeSaleItems: false,
		individualUse: false,
		createdAt: full.createdAt ?? "",
		updatedAt: full.updatedAt ?? "",
	};
}

/**
 * The discount `coupon` gives `cart` (which must carry its item subtotal),
 * or null when it does not apply: below the minimum, or a fixed coupon in
 * another currency. Dates and limits are checked by `checkCoupon`.
 */
export function discountFor(coupon: CartCoupon, cart: CartState): AppliedCoupon | null {
	if (cart.items.length === 0) return null;
	if (coupon.minSubtotal && cart.subtotal.amount < coupon.minSubtotal) return null;
	if (coupon.type === "fixed" && coupon.currency !== cart.currency) return null;
	return resolveDiscount(toCoreCoupon(coupon), cart);
}

export type CouponCheck =
	| { ok: true; coupon: LiteCoupon; cartCoupon: CartCoupon }
	| { ok: false; code: string; message: string };

const NOT_VALID_MESSAGE = "This coupon code is not valid";
const NOT_VALID = { ok: false as const, code: "COUPON_INVALID", message: NOT_VALID_MESSAGE };

/**
 * Read the coupon and check it against `cart` (priced, without a coupon
 * applied): active, in its dates, under its use limit, over its minimum,
 * in the cart's currency. One call, two when the coupon has a use limit.
 */
export async function checkCoupon(
	ctx: PluginContext,
	code: string,
	cart: CartState,
): Promise<CouponCheck> {
	const coupon = await couponsStore(ctx).get(code);
	if (!coupon) return { ...NOT_VALID, code: "COUPON_NOT_FOUND" };
	if (!coupon.active) return NOT_VALID;
	const uses = coupon.usageLimit ? await countUses(ctx, coupon.code) : 0;
	const result = validateCoupon(toCoreCoupon(coupon, uses), {
		cart: { ...cart, coupons: [] },
	});
	if (!result.ok)
		return { ok: false, code: "COUPON_INVALID", message: shopperMessage(result.reason) };
	return { ok: true, coupon, cartCoupon: toCartCoupon(coupon) };
}

/** Core's reasons, worded for the shopper. */
function shopperMessage(reason: string): string {
	if (reason.startsWith("Coupon expired")) return "This coupon has expired";
	if (reason.startsWith("Coupon not yet active")) return "This coupon is not active yet";
	if (reason.startsWith("Coupon usage limit")) return "This coupon has been used up";
	if (reason.startsWith("Cart subtotal below")) return "Add more to the cart to use this coupon";
	if (reason.startsWith("Coupon is in")) return "This coupon is not valid in this currency";
	return NOT_VALID_MESSAGE;
}

/** "10% off", "5.00 USD off", "Free shipping". */
export function describeCoupon(
	c: Pick<CartCoupon, "type" | "value" | "currency">,
	formatMinor: (minor: number, currency: string) => string,
): string {
	if (c.type === "percent") return `${c.value}% off`;
	if (c.type === "fixed") return `${formatMinor(c.value, c.currency)} ${c.currency} off`;
	return "Free shipping";
}

/**
 * Orders, stored in the plugin's `orders` storage collection.
 *
 * Status names and legal transitions come from core's order state machine
 * (`orders/status.ts`), so an order means the same thing in both plugins.
 */

import type { PluginContext } from "emdash/plugin";
import {
	canTransition,
	type Money,
	type OrderStatus,
	type PaymentStatus,
	randomId,
	type StripeSessionAddress,
} from "./shared";

export interface LiteOrderItem {
	productId: string;
	title: string;
	quantity: number;
	unitPrice: Money;
	lineTotal: Money;
	/**
	 * Present when the product had manage_stock on at checkout. `baseline`
	 * is its stock_quantity then (see stock.ts).
	 */
	stock?: { baseline: number; backorders: boolean };
}

export interface LiteAddress {
	name?: string;
	line1?: string;
	line2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	country?: string;
}

export interface LiteOrder {
	orderNumber: string;
	/** Random secret that lets the storefront read this order's status. */
	orderKey: string;
	/** sha256 of the cart token; used to clear the cart after payment. */
	cartId: string;
	status: OrderStatus;
	paymentStatus: PaymentStatus;
	currency: string;
	items: LiteOrderItem[];
	subtotal: Money;
	shippingTotal?: Money;
	taxTotal?: Money;
	/** Order total. With Stripe Tax this is updated to the charged amount on payment. */
	total: Money;
	/** Stripe Tax computes tax on the hosted page. */
	automaticTax?: boolean;
	/** Amount Stripe charged, minor units. */
	amountPaid?: number;
	/** Cumulative refunded amount from `charge.refunded`, minor units. */
	refundedAmount?: number;
	refundedAt?: string;
	/**
	 * Stock state for tracked items: taken on payment, put back on full
	 * refund or cancel. This is the target state; the per-line
	 * `stock_moves` ledger records what was actually applied (stock.ts).
	 */
	stock?: "deducted" | "restored";
	/**
	 * Set once the paid side effects (stock taken, cart cleared) are done.
	 * A retried webhook finishes them while this is unset.
	 */
	paidEffectsAt?: string;
	/**
	 * Checkout finished with a delayed payment method (ACH, SEPA debit and
	 * similar): Stripe sends `checkout.session.async_payment_succeeded` or
	 * `_failed` later. The order is `on-hold` + `pending` meanwhile, which
	 * the stale-order cleanup leaves alone.
	 */
	awaitingAsyncPayment?: boolean;
	/** Tracked items that sold beyond the stock on hand. */
	stockShortfall?: Array<{ productId: string; title: string; short: number }>;
	/** Why the order was cancelled, when the plugin cancelled it. */
	cancelReason?: "session_expired" | "stale" | "admin";
	/** Stripe livemode flag from the paid session, for dashboard links. */
	livemode?: boolean;
	/** Lowercased. */
	customerEmail?: string;
	shippingAddress?: LiteAddress;
	stripeSessionId?: string;
	stripePaymentIntentId?: string;
	/** Set when Stripe's charged amount or currency did not match the order. */
	amountMismatch?: { expected: Money; received: Money };
	createdAt: string;
	updatedAt: string;
	paidAt?: string;
}

export type OrdersStore = {
	get(id: string): Promise<LiteOrder | null>;
	put(id: string, data: LiteOrder): Promise<void>;
	getVersioned(id: string): Promise<{ value: LiteOrder; revision: string } | null>;
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: LiteOrder,
	): Promise<{ applied: boolean }>;
	updateIf(
		id: string,
		args: { where: Record<string, unknown>; set?: Partial<LiteOrder> },
	): Promise<{ applied: true; data: LiteOrder } | { applied: false }>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: LiteOrder }>; cursor?: string; hasMore: boolean }>;
	count(where?: Record<string, unknown>): Promise<number>;
};

export function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}

/** e.g. "DCL-LZ3K9Q-7F2A". Sortable prefix plus 4 random hex chars. */
export function newOrderNumber(now = Date.now()): string {
	return `DCL-${now.toString(36).toUpperCase()}-${randomId().slice(0, 4).toUpperCase()}`;
}

/**
 * Apply `mutate` to an order with optimistic concurrency. Retries a few
 * times when another request (for example a duplicate webhook delivery)
 * wrote the order in between. `mutate` returns null to skip the write.
 */
export async function updateOrder(
	store: OrdersStore,
	id: string,
	mutate: (order: LiteOrder) => LiteOrder | null,
	attempts = 3,
): Promise<{ order: LiteOrder | null; previous: LiteOrder | null; written: boolean }> {
	for (let i = 0; i < attempts; i += 1) {
		const current = await store.getVersioned(id);
		if (!current) return { order: null, previous: null, written: false };
		const next = mutate(current.value);
		if (!next) return { order: current.value, previous: current.value, written: false };
		const res = await store.compareAndSet(id, current.revision, {
			...next,
			updatedAt: new Date().toISOString(),
		});
		if (res.applied) return { order: next, previous: current.value, written: true };
	}
	throw new Error("Order update conflicted repeatedly");
}

/** Admin-initiated status change, validated against core's transitions. */
export function applyStatus(order: LiteOrder, to: OrderStatus): LiteOrder | null {
	if (order.status === to) return null;
	if (!canTransition(order.status, to)) return null;
	// Unpaid while a bank payment clears: the merchant can only cancel.
	if (isAwaitingAsyncPayment(order) && to !== "cancelled") return null;
	const { awaitingAsyncPayment: _awaiting, ...rest } = order;
	const next: LiteOrder = { ...rest, status: to };
	if (to === "cancelled") {
		next.cancelReason = "admin";
		// A cancelled paid order gives its stock back.
		if (order.stock === "deducted") next.stock = "restored";
	}
	return next;
}

/** On hold until Stripe reports the result of a delayed payment method. */
export function isAwaitingAsyncPayment(order: LiteOrder): boolean {
	return (
		order.awaitingAsyncPayment === true &&
		order.status === "on-hold" &&
		order.paymentStatus === "pending"
	);
}

export function fromStripeAddress(
	name: string | undefined,
	a: StripeSessionAddress | undefined,
): LiteAddress | undefined {
	if (!a) return undefined;
	const out: LiteAddress = {};
	if (name) out.name = name;
	if (a.line1) out.line1 = a.line1;
	if (a.line2) out.line2 = a.line2;
	if (a.city) out.city = a.city;
	if (a.state) out.state = a.state;
	if (a.postal_code) out.postalCode = a.postal_code;
	if (a.country) out.country = a.country;
	return out;
}

/** Fields the storefront may see for an order (via `order` route + key). */
export function toPublicOrder(id: string, o: LiteOrder) {
	return {
		id,
		orderNumber: o.orderNumber,
		status: o.status,
		paymentStatus: o.paymentStatus,
		currency: o.currency,
		items: o.items,
		subtotal: o.subtotal,
		shippingTotal: o.shippingTotal ?? { currency: o.currency, amount: 0 },
		taxTotal: o.taxTotal ?? { currency: o.currency, amount: 0 },
		total: o.total,
		refundedAmount: o.refundedAmount ?? 0,
		createdAt: o.createdAt,
		paidAt: o.paidAt ?? null,
	};
}

/** Constant-time string compare for order keys. */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

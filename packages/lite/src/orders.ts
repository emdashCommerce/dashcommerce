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
	total: Money;
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
): Promise<{ order: LiteOrder | null; written: boolean }> {
	for (let i = 0; i < attempts; i += 1) {
		const current = await store.getVersioned(id);
		if (!current) return { order: null, written: false };
		const next = mutate(current.value);
		if (!next) return { order: current.value, written: false };
		const res = await store.compareAndSet(id, current.revision, {
			...next,
			updatedAt: new Date().toISOString(),
		});
		if (res.applied) return { order: next, written: true };
	}
	throw new Error("Order update conflicted repeatedly");
}

/** Admin-initiated status change, validated against core's transitions. */
export function applyStatus(order: LiteOrder, to: OrderStatus): LiteOrder | null {
	if (order.status === to) return null;
	if (!canTransition(order.status, to)) return null;
	return { ...order, status: to };
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
		total: o.total,
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

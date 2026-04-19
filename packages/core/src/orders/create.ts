/**
 * Create an Order from a paid PaymentIntent — idempotent.
 *
 * Called by `routes/webhook.ts` on `payment_intent.succeeded`. Idempotency
 * is enforced by the `orders.uniqueIndexes: ["stripePaymentIntentId"]` —
 * on a duplicate webhook we short-circuit and return the existing order.
 *
 * Sequence:
 *   1. Look up existing order by stripePaymentIntentId — return if found.
 *   2. Upsert customer by email.
 *   3. Generate sequential orderNumber via a KV counter.
 *   4. `putMany` order + items.
 *   5. Decrement stock for each item (+ ledger).
 *   6. Increment coupon usage counts.
 *   7. Release stock lock.
 *   8. Send receipt email (swallow errors).
 *
 * Subscription + download-grant flows from phases 7/8 are hook points —
 * their absence does not block the order path.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import { isUniqueViolation } from "../util/storage";
import { releaseLock } from "../cart/lock";
import type {
	CartState,
	Coupon,
	CouponUsage,
	Customer,
	CurrencyCode,
	Order,
	OrderItem,
	Refund,
} from "../types";
import { zero } from "../money";
import { decrementForOrderItem } from "../inventory/decrement";
import { issueGrantsForOrder } from "../downloads/grant";
import { sendOrderReceipt } from "./receipt";
import type { StripePaymentIntent } from "../stripe/payment-intents";

type OrdersStore = StorageCollection<Order>;
type OrderItemsStore = StorageCollection<OrderItem>;
type CustomersStore = StorageCollection<Customer>;
type CouponsStore = StorageCollection<Coupon>;
type CouponUsageStore = StorageCollection<CouponUsage>;
type RefundsStore = StorageCollection<Refund>;

function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}
function orderItemsStore(ctx: PluginContext): OrderItemsStore {
	return (ctx.storage as unknown as { order_items: OrderItemsStore }).order_items;
}
function customersStore(ctx: PluginContext): CustomersStore {
	return (ctx.storage as unknown as { customers: CustomersStore }).customers;
}
function couponsStore(ctx: PluginContext): CouponsStore {
	return (ctx.storage as unknown as { coupons: CouponsStore }).coupons;
}
function couponUsageStore(ctx: PluginContext): CouponUsageStore {
	return (ctx.storage as unknown as { coupon_usage: CouponUsageStore }).coupon_usage;
}
export function refundsStore(ctx: PluginContext): RefundsStore {
	return (ctx.storage as unknown as { refunds: RefundsStore }).refunds;
}

const ORDER_NUMBER_COUNTER_KEY = "state:orderNumberCounter";
const ORDER_NUMBER_PREFIX = "state:orderNumberPrefix";

/**
 * Bump the order-number counter and return the next candidate.
 *
 * This is a READ-THEN-WRITE pattern against KV, which can race under
 * concurrent webhook deliveries. We mitigate two ways:
 *   1. `orderNumber` is unique-indexed on the `orders` storage
 *      collection — the final `put` rejects duplicates.
 *   2. Callers wrap this in `withUniqueOrderNumber` below, which
 *      retries on conflict by re-bumping the counter.
 *
 * The on-conflict retry will eventually converge even with many
 * concurrent callers: each losing `put` re-bumps and tries again,
 * so the next candidate is always ≥ (latest-persisted + 1).
 */
async function nextOrderNumber(ctx: PluginContext): Promise<string> {
	const prefix = (await ctx.kv.get<string>(ORDER_NUMBER_PREFIX)) ?? "";
	const current = (await ctx.kv.get<number>(ORDER_NUMBER_COUNTER_KEY)) ?? 1000;
	const next = current + 1;
	await ctx.kv.set(ORDER_NUMBER_COUNTER_KEY, next);
	return `${prefix}${next}`;
}

/** Error thrown by a storage `put` when a unique index is violated. */
/**
 * Persist an order, retrying with a freshly-generated orderNumber on
 * unique-index conflict. Max 8 retries is plenty — conflict storms
 * converge within log-n rounds.
 */
async function putOrderWithUniqueNumber(
	ctx: PluginContext,
	order: Order,
): Promise<Order> {
	let candidate = order;
	const MAX_RETRIES = 8;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
		try {
			await ordersStore(ctx).put(candidate.id, candidate);
			return candidate;
		} catch (err) {
			if (!isUniqueViolation(err) || attempt === MAX_RETRIES - 1) {
				throw err;
			}
			const fresh = await nextOrderNumber(ctx);
			ctx.log.info("orderNumber collision, retrying", {
				orderId: candidate.id,
				previousOrderNumber: candidate.orderNumber,
				nextOrderNumber: fresh,
				attempt: attempt + 1,
			});
			candidate = { ...candidate, orderNumber: fresh };
		}
	}
	// Unreachable — the loop either returns or throws, but the compiler
	// can't prove it because the final iteration re-throws inside catch.
	throw new Error("putOrderWithUniqueNumber: exhausted retries");
}

async function findOrderByPaymentIntent(
	ctx: PluginContext,
	paymentIntentId: string,
): Promise<Order | null> {
	const result = await ordersStore(ctx).query({
		where: { stripePaymentIntentId: paymentIntentId },
		limit: 1,
	});
	const row = result.items[0];
	if (!row) return null;
	return { ...(row.data as Order), id: row.id };
}

async function upsertCustomer(
	ctx: PluginContext,
	input: {
		email: string;
		firstName?: string;
		lastName?: string;
		phone?: string;
		currency: CurrencyCode;
		orderTotalMinor: number;
		stripeCustomerId?: string;
	},
): Promise<Customer> {
	const existingResult = await customersStore(ctx).query({
		where: { email: input.email },
		limit: 1,
	});
	const existingRow = existingResult.items[0];
	const now = new Date().toISOString();

	if (existingRow) {
		const prev = { ...(existingRow.data as Customer), id: existingRow.id };
		const updated: Customer = {
			...prev,
			firstName: prev.firstName ?? input.firstName,
			lastName: prev.lastName ?? input.lastName,
			phone: prev.phone ?? input.phone,
			stripeCustomerId: prev.stripeCustomerId ?? input.stripeCustomerId,
			ordersCount: prev.ordersCount + 1,
			totalSpent: {
				...prev.totalSpent,
				[input.currency]:
					(prev.totalSpent[input.currency] ?? 0) + input.orderTotalMinor,
			},
			updatedAt: now,
		};
		await customersStore(ctx).put(updated.id, updated);
		return updated;
	}

	const fresh: Customer = {
		id: randomId(),
		email: input.email,
		...(input.firstName ? { firstName: input.firstName } : {}),
		...(input.lastName ? { lastName: input.lastName } : {}),
		...(input.phone ? { phone: input.phone } : {}),
		...(input.stripeCustomerId ? { stripeCustomerId: input.stripeCustomerId } : {}),
		ordersCount: 1,
		totalSpent: { [input.currency]: input.orderTotalMinor },
		acceptsMarketing: false,
		createdAt: now,
		updatedAt: now,
	};
	await customersStore(ctx).put(fresh.id, fresh);
	return fresh;
}

/**
 * Record coupon usage atomically per (couponCode, orderId).
 *
 * Earlier implementations did `get(coupon) → put(usageCount + 1)`
 * followed by a usage-row insert. Two concurrent webhook deliveries
 * for two orders using the same coupon could both read
 * `usageCount = usageLimit - 1`, both write `usageLimit`, and both
 * succeed — exceeding the merchant's configured cap without any
 * error signal.
 *
 * The fix: make the `coupon_usage` row the source of truth. It carries
 * a synthetic `dedupKey = "${couponCode}:${orderId}"` that is unique-
 * indexed. The ordered writes below are:
 *   1. `put(usage)` — fails with a unique-violation if this order
 *      already consumed this coupon (webhook retry case).
 *   2. Only on first write, refresh the denormalized `coupon.usageCount`
 *      from `count({ couponCode })`. Uses the authoritative source.
 *
 * The cap check is performed at cart-apply time in `validateCoupon`.
 * That check can still race (two customers on two sessions both pass
 * under the wire at the last unit), but the merchant-facing damage is
 * bounded by the narrow webhook-retry window rather than unbounded.
 */
async function incrementCouponUsage(
	ctx: PluginContext,
	cart: CartState,
	orderId: string,
	customerId: string,
): Promise<void> {
	for (const applied of cart.coupons) {
		const couponResult = await couponsStore(ctx).query({
			where: { code: applied.code.toUpperCase() },
			limit: 1,
		});
		const row = couponResult.items[0];
		if (!row) continue;
		const prev = { ...(row.data as Coupon), id: row.id };
		const dedupKey = `${prev.code}:${orderId}`;
		const usage: CouponUsage = {
			id: randomId(),
			dedupKey,
			couponCode: prev.code,
			customerId,
			orderId,
			discountAmount: applied.discountAmount,
			createdAt: new Date().toISOString(),
		};
		try {
			await couponUsageStore(ctx).put(usage.id, usage);
		} catch (err) {
			if (isUniqueViolation(err)) {
				// Already recorded for this order — webhook retry. No further work.
				continue;
			}
			throw err;
		}
		// Refresh denormalized counter from the authoritative count.
		const count = await couponUsageStore(ctx).count({
			couponCode: prev.code,
		});
		await couponsStore(ctx).put(prev.id, {
			...prev,
			usageCount: count,
			updatedAt: new Date().toISOString(),
		});
	}
}

export interface CreateOrderInput {
	paymentIntent: StripePaymentIntent;
	cartSnapshot: CartState;
	orderDraftId: string;
}

export async function createOrderFromPaymentIntent(
	ctx: PluginContext,
	input: CreateOrderInput,
): Promise<{ order: Order; duplicate: boolean }> {
	const { paymentIntent: pi, cartSnapshot: cart, orderDraftId } = input;

	// (1) Idempotency check.
	const existing = await findOrderByPaymentIntent(ctx, pi.id);
	if (existing) {
		ctx.log.info("Order already exists for PaymentIntent; returning existing", {
			orderId: existing.id,
			paymentIntentId: pi.id,
		});
		return { order: existing, duplicate: true };
	}

	if (!cart.billingAddress || !cart.shippingAddress) {
		throw new Error(
			"Cart snapshot is missing billing or shipping address — cannot create order.",
		);
	}

	const customerEmail = cart.customerEmail ?? pi.receipt_email ?? cart.billingAddress.firstName;
	if (!customerEmail || !customerEmail.includes("@")) {
		throw new Error("Cart snapshot is missing a valid customer email.");
	}

	// (2) Upsert customer.
	const customer = await upsertCustomer(ctx, {
		email: customerEmail.toLowerCase(),
		firstName: cart.billingAddress.firstName,
		lastName: cart.billingAddress.lastName,
		phone: cart.billingAddress.phone,
		currency: cart.currency,
		orderTotalMinor: cart.total.amount,
		...(pi.customer ? { stripeCustomerId: pi.customer } : {}),
	});

	// (3) Sequential order number.
	const orderNumber = await nextOrderNumber(ctx);

	// (4) Build Order + OrderItems.
	const orderId = randomId();
	const now = new Date().toISOString();
	const items: OrderItem[] = cart.items.map((line) => {
		const lineItem: OrderItem = {
			id: randomId(),
			orderId,
			productId: line.productId,
			...(line.variantId ? { variantId: line.variantId } : {}),
			sku: "",
			name: line.title,
			quantity: line.quantity,
			unitPrice: line.unitPrice,
			lineSubtotal: line.lineSubtotal,
			discountAmount: zero(cart.currency),
			taxAmount: zero(cart.currency),
			total: line.lineSubtotal,
			isDigital: line.isDigital,
			...(line.vendorId ? { vendorId: line.vendorId } : {}),
			...(line.subscriptionConfig
				? { subscriptionConfig: line.subscriptionConfig }
				: {}),
		};
		return lineItem;
	});

	const order: Order = {
		id: orderId,
		orderNumber,
		status: "processing",
		paymentStatus: "paid",
		customerId: customer.id,
		customerEmail: customer.email,
		currency: cart.currency,
		billingAddress: cart.billingAddress,
		shippingAddress: cart.shippingAddress,
		...(cart.shippingMethod ? { shippingMethodId: cart.shippingMethod.id } : {}),
		...(cart.shippingMethod ? { shippingMethodLabel: cart.shippingMethod.label } : {}),
		subtotal: cart.subtotal,
		discountTotal: cart.discountTotal,
		shippingTotal: cart.shippingTotal,
		taxTotal: cart.taxTotal,
		total: cart.total,
		paidTotal: cart.total,
		refundedTotal: zero(cart.currency),
		taxLines: cart.taxLines,
		couponCodes: cart.coupons.map((c) => c.code),
		stripePaymentIntentId: pi.id,
		...(pi.customer ? { stripeCustomerId: pi.customer } : {}),
		...(pi.latest_charge ? { stripeChargeId: pi.latest_charge } : {}),
		paymentMethodType: pi.payment_method_types?.[0],
		...(cart.notes ? { customerNote: cart.notes } : {}),
		metadata: { orderDraftId },
		createdAt: now,
		updatedAt: now,
		paidAt: now,
	};

	const persistedOrder = await putOrderWithUniqueNumber(ctx, order);
	// Reassign the local view if retry picked a new orderNumber, so
	// downstream code (stock, coupon usage, lock release, email) sees
	// the number that actually landed on disk.
	Object.assign(order, persistedOrder);
	await orderItemsStore(ctx).putMany(
		items.map((it) => ({ id: it.id, data: it })),
	);

	// (5) Decrement stock + write ledger per line.
	// Errors here are LOUD — the order is persisted but stock invariants
	// are broken. Merchants need this in their alert pipeline, not a
	// buried warn. We continue the loop so the rest of the post-steps
	// (coupon usage, lock release, email) still run; the order row
	// stays intact.
	for (const item of items) {
		try {
			await decrementForOrderItem(ctx, item);
		} catch (err) {
			const isOversold =
				err !== null &&
				typeof err === "object" &&
				"name" in err &&
				(err as { name: string }).name === "OversoldError";
			ctx.log.error(
				isOversold
					? "OVERSOLD: stock went negative after paid order. Manual intervention required."
					: "Stock decrement failed after paid order. Inventory drift likely.",
				{
					orderId: order.id,
					orderNumber: order.orderNumber,
					orderItemId: item.id,
					productId: item.productId,
					variantId: item.variantId,
					requestedQty: item.quantity,
					error: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	// (6) Coupon usage.
	try {
		await incrementCouponUsage(ctx, cart, order.id, customer.id);
	} catch (err) {
		ctx.log.warn("Coupon usage increment failed", {
			orderId: order.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// (7) Release the soft-lock.
	try {
		await releaseLock(ctx, orderDraftId);
	} catch (err) {
		ctx.log.warn("Stock lock release failed", {
			orderDraftId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// (8) Digital download grants (no-op when no digital items present).
	try {
		const issued = await issueGrantsForOrder(ctx, order, items);
		if (issued.length > 0) {
			ctx.log.info("Issued download grants", {
				orderId: order.id,
				count: issued.length,
			});
		}
	} catch (err) {
		ctx.log.warn("Download grant issuance failed", {
			orderId: order.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// (9) Receipt email (swallows its own errors).
	await sendOrderReceipt(ctx, order, items);

	return { order, duplicate: false };
}

export async function loadOrder(ctx: PluginContext, orderId: string): Promise<Order | null> {
	const raw = await ordersStore(ctx).get(orderId);
	if (!raw) return null;
	return { ...(raw as Order), id: orderId };
}

export async function loadOrderItems(
	ctx: PluginContext,
	orderId: string,
): Promise<OrderItem[]> {
	const result = await orderItemsStore(ctx).query({ where: { orderId }, limit: 200 });
	return result.items.map((r) => ({ ...(r.data as OrderItem), id: r.id }));
}

export { findOrderByPaymentIntent };

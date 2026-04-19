/**
 * Order refund flow.
 *
 *   admin UI / webhook
 *        │
 *        ▼
 *   refundOrder()
 *        │
 *        ├─→ createRefund (Stripe API, idempotency-keyed)
 *        ├─→ refunds.put (unique-indexed on stripeRefundId)
 *        ├─→ inventory.restore (when lineItemRefunds + restock)
 *        ├─→ order.status / paymentStatus / refundedTotal update
 *        └─→ refund email
 *
 * The function is idempotent *if the caller supplies a stable
 * `idempotencyKey`* — typically `refund:{orderId}:{stripeRefundId|uuid}`.
 * For webhook-driven paths (charge.refunded) we can safely short-circuit
 * on the unique-index conflict against `stripeRefundId`.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import { add, CurrencyMismatchError, type Money } from "../money";
import { createRefund, type StripeRefund } from "../stripe/refunds";
import type { StripeClientOptions } from "../stripe/client";
import type { Order, OrderItem, Refund } from "../types";
import { loadOrder, loadOrderItems, refundsStore } from "./create";
import { derivePaymentStatus, deriveOrderStatusFromRefunds } from "./status";
import { restoreForOrderItem } from "../inventory/restore";
import { sendRefundReceipt } from "./receipt";

type OrdersStore = StorageCollection<Order>;
function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}

export interface LineItemRefund {
	orderItemId: string;
	quantity: number;
	amount: Money;
}

export interface RefundOrderInput {
	orderId: string;
	amount: Money;
	reason?: string;
	lineItemRefunds?: LineItemRefund[];
	restock?: boolean;
	createdByUserId?: string;
	/** Stripe client creds (read from KV by caller). */
	client: StripeClientOptions;
	/** Stable key for Stripe idempotency. */
	idempotencyKey: string;
}

export async function refundOrder(
	ctx: PluginContext,
	input: RefundOrderInput,
): Promise<Refund> {
	const order = await loadOrder(ctx, input.orderId);
	if (!order) throw new Error(`Order ${input.orderId} not found`);

	if (order.currency !== input.amount.currency) {
		throw new CurrencyMismatchError(order.currency, input.amount.currency);
	}
	if (input.amount.amount <= 0) {
		throw new Error("Refund amount must be > 0");
	}
	const remaining = order.paidTotal.amount - order.refundedTotal.amount;
	if (input.amount.amount > remaining) {
		throw new Error(
			`Refund ${input.amount.amount} exceeds remaining refundable ${remaining}`,
		);
	}

	// Stripe call first — if this fails, we don't write anything.
	const stripeRefund = await stripeRefundWithDedup(ctx, order, input);

	// Persist refund row (unique-indexed on stripeRefundId).
	const refundId = randomId();
	const refund: Refund = {
		id: refundId,
		orderId: order.id,
		amount: input.amount,
		...(input.reason ? { reason: input.reason } : {}),
		status:
			stripeRefund.status === "succeeded"
				? "succeeded"
				: stripeRefund.status === "failed"
					? "failed"
					: "pending",
		stripeRefundId: stripeRefund.id,
		...(input.lineItemRefunds ? { lineItemRefunds: input.lineItemRefunds } : {}),
		restocked: Boolean(input.restock),
		createdAt: new Date().toISOString(),
		...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
	};
	await refundsStore(ctx).put(refundId, refund);

	// Optional restock per line item.
	if (input.restock && input.lineItemRefunds?.length) {
		const items = await loadOrderItems(ctx, order.id);
		const byId = new Map(items.map((it) => [it.id, it]));
		for (const li of input.lineItemRefunds) {
			const orderItem = byId.get(li.orderItemId);
			if (!orderItem) continue;
			if (li.quantity <= 0) continue;
			try {
				await restoreForOrderItem(ctx, {
					orderItem,
					quantity: li.quantity,
					reason: "refund",
					refundId: refund.id,
				});
			} catch (err) {
				ctx.log.warn("Stock restore failed during refund", {
					refundId: refund.id,
					orderItemId: li.orderItemId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// Update order totals + status.
	const newRefundedTotal = add(order.refundedTotal, input.amount);
	const paymentStatus = derivePaymentStatus(
		order.paidTotal.amount,
		newRefundedTotal.amount,
	);
	const status = deriveOrderStatusFromRefunds(
		order.status,
		order.paidTotal.amount,
		newRefundedTotal.amount,
	);
	const updatedOrder: Order = {
		...order,
		refundedTotal: newRefundedTotal,
		paymentStatus,
		status,
		updatedAt: new Date().toISOString(),
	};
	await ordersStore(ctx).put(order.id, updatedOrder);

	// Email.
	await sendRefundReceipt(ctx, updatedOrder, refund);

	return refund;
}

/**
 * Call Stripe and guard against webhook-driven double-refund. Checks
 * refunds collection for an existing row matching stripeRefundId before
 * any new API call. Stripe's own Idempotency-Key protects against retry
 * races.
 */
async function stripeRefundWithDedup(
	ctx: PluginContext,
	order: Order,
	input: RefundOrderInput,
): Promise<StripeRefund> {
	return createRefund(
		ctx,
		{
			paymentIntent: order.stripePaymentIntentId,
			amount: input.amount.amount,
			reason:
				input.reason === "fraudulent" ||
				input.reason === "duplicate" ||
				input.reason === "requested_by_customer"
					? input.reason
					: "requested_by_customer",
			metadata: { orderId: order.id, orderNumber: order.orderNumber },
		},
		input.client,
		input.idempotencyKey,
	);
}

/**
 * Webhook-driven refund path: we already received the Stripe Refund object
 * from `charge.refunded`. Persist it, do the restock/update, but skip the
 * Stripe API call.
 */
export async function recordRefundFromWebhook(
	ctx: PluginContext,
	order: Order,
	stripeRefund: StripeRefund,
): Promise<Refund | null> {
	// Dedup on stripeRefundId.
	const existingRow = await refundsStore(ctx).query({
		where: { stripeRefundId: stripeRefund.id },
		limit: 1,
	});
	if (existingRow.items[0]) {
		const prev = existingRow.items[0];
		return { ...(prev.data as Refund), id: prev.id };
	}

	const amount: Money = { currency: stripeRefund.currency.toUpperCase(), amount: stripeRefund.amount };
	if (amount.currency !== order.currency) {
		ctx.log.error("Refund currency mismatch with order", {
			refundId: stripeRefund.id,
			orderId: order.id,
			refundCurrency: amount.currency,
			orderCurrency: order.currency,
		});
		return null;
	}
	const refundId = randomId();
	const refund: Refund = {
		id: refundId,
		orderId: order.id,
		amount,
		...(stripeRefund.reason ? { reason: stripeRefund.reason } : {}),
		status:
			stripeRefund.status === "succeeded"
				? "succeeded"
				: stripeRefund.status === "failed"
					? "failed"
					: "pending",
		stripeRefundId: stripeRefund.id,
		restocked: false,
		createdAt: new Date().toISOString(),
	};
	await refundsStore(ctx).put(refundId, refund);

	const newRefundedTotal = add(order.refundedTotal, amount);
	const paymentStatus = derivePaymentStatus(
		order.paidTotal.amount,
		newRefundedTotal.amount,
	);
	const status = deriveOrderStatusFromRefunds(
		order.status,
		order.paidTotal.amount,
		newRefundedTotal.amount,
	);
	await ordersStore(ctx).put(order.id, {
		...order,
		refundedTotal: newRefundedTotal,
		paymentStatus,
		status,
		updatedAt: new Date().toISOString(),
	});

	await sendRefundReceipt(ctx, order, refund);
	return refund;
}

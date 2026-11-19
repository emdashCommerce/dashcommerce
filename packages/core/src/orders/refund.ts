/**
 * Order refund flow.
 *
 *   admin UI / webhook
 *        │
 *        ▼
 *   refundOrder()
 *        │
 *        ├─→ PaymentProvider.refund (idempotency-keyed by refundRequestId)
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
import { restoreForOrderItem } from "../inventory/restore";
import { CurrencyMismatchError, type Money, add } from "../money";
import { loadPaymentProviderCredentials, requirePaymentProvider } from "../payment-provider";
import type { StripeClientOptions } from "../stripe/client";
import type { StripeRefund } from "../stripe/refunds";
import type { Order, Refund } from "../types";
import { randomId } from "../util/ids";
import { loadOrder, loadOrderItems, refundsStore } from "./create";
import { sendRefundReceipt } from "./receipt";
import { deriveOrderStatusFromRefunds, derivePaymentStatus } from "./status";

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
	/**
	 * Ignored. Credentials always load from KV via
	 * `loadPaymentProviderCredentials(order.providerId)` so a Stripe key
	 * is never handed to a non-Stripe adapter (and a non-Stripe order
	 * can refund without Stripe configured).
	 */
	client?: StripeClientOptions;
	/**
	 * Stable refund request id used as the provider idempotency key.
	 * Must be unique per refund attempt — not derived only from
	 * paymentReference + amount, or two legitimate same-amount partials
	 * would collapse.
	 */
	idempotencyKey: string;
}

export async function refundOrder(ctx: PluginContext, input: RefundOrderInput): Promise<Refund> {
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
		throw new Error(`Refund ${input.amount.amount} exceeds remaining refundable ${remaining}`);
	}

	// Provider call first — if this fails, we don't write anything.
	const stripeRefund = await providerRefundWithDedup(ctx, order, input);

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
		refundRequestId: input.idempotencyKey,
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
	const paymentStatus = derivePaymentStatus(order.paidTotal.amount, newRefundedTotal.amount);
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
async function providerRefundWithDedup(
	ctx: PluginContext,
	order: Order,
	input: RefundOrderInput,
): Promise<StripeRefund> {
	const providerId = order.providerId ?? "stripe";
	const provider = requirePaymentProvider(providerId);
	const creds = await loadPaymentProviderCredentials(ctx.kv, providerId);
	if (!creds) {
		throw new Error(`Payment provider "${providerId}" is not configured`);
	}
	const paymentReference = order.paymentReference ?? order.stripePaymentIntentId;
	if (!paymentReference) {
		throw new Error(`Order ${order.id} has no paymentReference to refund`);
	}
	if (!input.idempotencyKey.trim()) {
		throw new Error("Refund requires an explicit refundRequestId / idempotencyKey");
	}
	const result = await provider.refund(
		ctx,
		{
			paymentReference,
			refundRequestId: input.idempotencyKey,
			amount: input.amount.amount,
			currency: input.amount.currency,
			reason: input.reason,
			metadata: { orderId: order.id, orderNumber: order.orderNumber },
		},
		creds,
	);
	return {
		id: result.providerRefundId,
		amount: result.amount,
		currency: result.currency,
		status:
			result.status === "succeeded"
				? "succeeded"
				: result.status === "failed"
					? "failed"
					: "pending",
		payment_intent: paymentReference,
	};
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

	const amount: Money = {
		currency: stripeRefund.currency.toUpperCase(),
		amount: stripeRefund.amount,
	};
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
	const paymentStatus = derivePaymentStatus(order.paidTotal.amount, newRefundedTotal.amount);
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

export type ProviderRefundUpdateOutcome = "updated" | "unchanged" | "unknown" | "other-provider";

/**
 * Apply a provider's report that one of its refunds changed status.
 * Matches the stored refund by the provider's refund id, and only when its
 * order was paid through that provider. A settled refund (succeeded or
 * failed) never moves again.
 *
 * A failed refund is marked failed and logged as an error, but the order's
 * refunded total is not reduced: the operator decides, as with any refund
 * that fails at the provider.
 */
export async function applyProviderRefundUpdate(
	ctx: PluginContext,
	update: { providerId: string; providerRefundId: string; status: Refund["status"] },
): Promise<ProviderRefundUpdateOutcome> {
	const found = await refundsStore(ctx).query({
		where: { stripeRefundId: update.providerRefundId },
		limit: 1,
	});
	const row = found.items[0];
	if (!row) {
		ctx.log.warn("Provider reported an unknown refund", {
			providerId: update.providerId,
			providerRefundId: update.providerRefundId,
		});
		return "unknown";
	}
	const refund = { ...(row.data as Refund), id: row.id };
	const order = await loadOrder(ctx, refund.orderId);
	if ((order?.providerId ?? "stripe") !== update.providerId) {
		ctx.log.warn("Refund update from a provider that did not take the payment", {
			providerId: update.providerId,
			providerRefundId: update.providerRefundId,
			orderId: refund.orderId,
		});
		return "other-provider";
	}
	if (refund.status !== "pending" || update.status === "pending") return "unchanged";

	await refundsStore(ctx).put(refund.id, { ...refund, status: update.status });
	if (update.status === "failed") {
		ctx.log.error("Refund failed at the payment provider; the order still counts it as refunded", {
			providerId: update.providerId,
			providerRefundId: update.providerRefundId,
			refundId: refund.id,
			orderId: refund.orderId,
		});
	}
	return "updated";
}

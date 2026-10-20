/**
 * Stripe webhook.
 *
 * The route declares `request: { body: "text", headers: ["stripe-signature"] }`
 * so the handler receives the exact raw body Stripe signed, and verifies it
 * with core's Web Crypto `verifyStripeSignature()`. No dispatch patches are
 * needed.
 *
 * The route uses `response: "raw"` so it can answer 400 for a bad signature
 * and 500 when processing fails (Stripe then retries). Handled events:
 *
 *   checkout.session.completed              paid -> mark paid, take stock
 *   checkout.session.async_payment_succeeded       -> mark paid, take stock
 *   checkout.session.async_payment_failed          -> mark failed
 *   checkout.session.expired                       -> cancel pending order
 *   charge.refunded                                -> record refund; a full
 *                                                     refund restores stock
 *
 * Every processed event id is recorded in `stripe_events`; a repeated
 * delivery is acknowledged without side effects. Order writes use
 * compare-and-set, so concurrent duplicate deliveries are also safe.
 */

import type { PluginContext } from "emdash/plugin";
import { cartsStore } from "./cart";
import {
	fromStripeAddress,
	type LiteOrder,
	ordersStore,
	stockToRestore,
	updateOrder,
} from "./orders";
import {
	deriveOrderStatusFromRefunds,
	derivePaymentStatus,
	money,
	type StripeCheckoutSession,
	verifyStripeSignature,
} from "./shared";
import { deductStock, restoreStock } from "./stock";

export interface WebhookResult {
	status: number;
	body: Record<string, unknown>;
}

interface StripeEvent {
	id: string;
	type: string;
	livemode?: boolean;
	data: { object: Record<string, unknown> };
}

/** The fields of a Stripe Charge that refunds need. */
export interface StripeCharge {
	id: string;
	object?: "charge";
	amount?: number;
	amount_refunded?: number;
	currency?: string;
	payment_intent?: string | null;
	refunded?: boolean;
	metadata?: Record<string, string>;
}

type SessionWithExtras = StripeCheckoutSession & {
	livemode?: boolean;
	total_details?: { amount_tax?: number; amount_shipping?: number };
	collected_information?: { shipping_details?: StripeCheckoutSession["shipping_details"] };
};

type EventsStore = {
	exists(id: string): Promise<boolean>;
	put(id: string, data: Record<string, unknown>): Promise<void>;
};

export const HANDLED_EVENTS = [
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"checkout.session.async_payment_failed",
	"checkout.session.expired",
	"charge.refunded",
] as const;

const HANDLED = new Set<string>(HANDLED_EVENTS);

export async function handleStripeWebhook(
	ctx: PluginContext,
	payload: unknown,
	headers: Record<string, string>,
	now = Date.now(),
): Promise<WebhookResult> {
	const secret = await ctx.settings.get<string>("stripeWebhookSecret");
	if (!secret) {
		ctx.log.warn("Stripe webhook received but no signing secret is configured");
		return { status: 500, body: { error: "webhook_not_configured" } };
	}
	if (typeof payload !== "string" || payload.length === 0) {
		return { status: 400, body: { error: "empty_body" } };
	}
	const verified = await verifyStripeSignature({
		payload,
		signatureHeader: headers["stripe-signature"] ?? "",
		secret,
		now,
	});
	if (!verified.ok) return { status: 400, body: { error: "invalid_signature" } };

	let event: StripeEvent;
	try {
		event = JSON.parse(payload) as StripeEvent;
	} catch {
		return { status: 400, body: { error: "invalid_json" } };
	}
	if (typeof event?.id !== "string" || typeof event.type !== "string" || !event.data?.object) {
		return { status: 400, body: { error: "invalid_event" } };
	}
	if (!HANDLED.has(event.type)) return { status: 200, body: { received: true, ignored: true } };

	const events = (ctx.storage as unknown as { stripe_events: EventsStore }).stripe_events;
	if (await events.exists(event.id)) {
		return { status: 200, body: { received: true, duplicate: true } };
	}

	let outcome: string;
	try {
		outcome =
			event.type === "charge.refunded"
				? await processChargeRefunded(ctx, event.data.object as unknown as StripeCharge, now)
				: await processSessionEvent(
						ctx,
						event.type,
						event.data.object as unknown as SessionWithExtras,
						now,
					);
	} catch (err) {
		ctx.log.error("Stripe webhook processing failed", {
			type: event.type,
			message: err instanceof Error ? err.message : "unknown",
		});
		return { status: 500, body: { error: "processing_failed" } };
	}
	await events.put(event.id, {
		type: event.type,
		outcome,
		createdAt: new Date(now).toISOString(),
	});
	return { status: 200, body: { received: true, outcome } };
}

async function processSessionEvent(
	ctx: PluginContext,
	type: string,
	session: SessionWithExtras,
	now: number,
): Promise<string> {
	const orderId = session.metadata?.orderId ?? session.client_reference_id;
	if (!orderId) return "no_order_reference";
	const store = ordersStore(ctx);

	const sessionMatches = (o: LiteOrder) => !o.stripeSessionId || o.stripeSessionId === session.id;

	if (
		type === "checkout.session.completed" ||
		type === "checkout.session.async_payment_succeeded"
	) {
		if (session.payment_status !== "paid") return "awaiting_payment";
		const { order, written } = await updateOrder(store, orderId, (o) =>
			sessionMatches(o) ? markPaid(o, session, now) : null,
		);
		if (!order) {
			ctx.log.warn("Stripe session references an unknown order", { orderId });
			return "order_not_found";
		}
		if (!written) return "unchanged";

		// Payment confirmed: take the items out of stock, then empty the cart.
		let outcome = order.amountMismatch ? "paid_amount_mismatch" : "paid";
		if (order.stock === "deducted") {
			const shortfalls = await deductStock(ctx, orderId, order.items, now);
			if (shortfalls.length > 0) {
				await updateOrder(store, orderId, (o) => ({
					...o,
					status: "on-hold",
					stockShortfall: shortfalls,
				}));
				ctx.log.warn("Paid order sold more than the stock on hand", { orderId });
				outcome = "paid_stock_shortfall";
			}
		}
		await cartsStore(ctx).delete(order.cartId);
		return outcome;
	}

	if (type === "checkout.session.async_payment_failed") {
		const { order } = await updateOrder(store, orderId, (o) =>
			sessionMatches(o) && o.paymentStatus === "pending"
				? { ...o, status: "failed", paymentStatus: "failed" }
				: null,
		);
		return order ? "failed" : "order_not_found";
	}

	// checkout.session.expired
	const { order } = await updateOrder(store, orderId, (o) =>
		sessionMatches(o) && o.status === "pending" && o.paymentStatus === "pending"
			? { ...o, status: "cancelled", cancelReason: "session_expired" }
			: null,
	);
	return order ? "expired" : "order_not_found";
}

/**
 * Pure transition to "paid". Returns null when the order is already paid
 * (idempotent). A charged amount that differs from the order total puts
 * the order on hold for the merchant instead of marking it processing.
 * With Stripe Tax, the expected amount is the order total plus the tax
 * Stripe reports in `total_details.amount_tax`.
 */
export function markPaid(
	order: LiteOrder,
	session: SessionWithExtras,
	now: number,
): LiteOrder | null {
	if (order.paymentStatus === "paid") return null;
	const receivedCurrency = (session.currency ?? "").toUpperCase();
	const receivedAmount = session.amount_total ?? -1;
	const stripeTax = order.automaticTax ? (session.total_details?.amount_tax ?? 0) : 0;
	const expectedAmount = order.total.amount + stripeTax;
	const mismatch = receivedAmount !== expectedAmount || receivedCurrency !== order.total.currency;

	const collected = session.collected_information?.shipping_details;
	const shipping = collected ?? session.shipping_details;
	const email = session.customer_details?.email ?? order.customerEmail;
	const address = fromStripeAddress(shipping?.name, shipping?.address);
	const tracked = order.items.some((i) => i.stock);

	const next: LiteOrder = {
		...order,
		status: mismatch ? "on-hold" : "processing",
		paymentStatus: "paid",
		paidAt: new Date(now).toISOString(),
		amountPaid: receivedAmount,
		stripeSessionId: session.id,
		...(session.payment_intent ? { stripePaymentIntentId: String(session.payment_intent) } : {}),
		...(email ? { customerEmail: email.toLowerCase() } : {}),
		...(address ? { shippingAddress: address } : {}),
		...(typeof session.livemode === "boolean" ? { livemode: session.livemode } : {}),
		...(tracked ? { stock: "deducted" as const } : {}),
	};
	if (order.automaticTax && !mismatch) {
		next.taxTotal = money(order.currency, stripeTax);
		next.total = money(order.currency, receivedAmount);
	}
	if (mismatch) {
		next.amountMismatch = {
			expected: money(order.currency, expectedAmount),
			received: { currency: receivedCurrency, amount: receivedAmount },
		};
	}
	return next;
}

async function processChargeRefunded(
	ctx: PluginContext,
	charge: StripeCharge,
	now: number,
): Promise<string> {
	const store = ordersStore(ctx);
	const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : undefined;
	let orderId = charge.metadata?.orderId;
	if (!orderId && pi) {
		const found = await store.query({ where: { stripePaymentIntentId: pi }, limit: 1 });
		orderId = found.items[0]?.id;
	}
	if (!orderId) return "order_not_found";
	const refunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
	const { order, previous, written } = await updateOrder(store, orderId, (o) =>
		applyRefund(o, refunded, charge, now),
	);
	if (!order) return "order_not_found";
	if (!written) return "unchanged";
	if (previous && stockToRestore(previous, order)) {
		await restoreStock(ctx, orderId, order.items, "refund", now);
	}
	return order.paymentStatus === "refunded" ? "refunded" : "partially_refunded";
}

/**
 * Pure refund transition. `amount_refunded` is cumulative on the Charge,
 * so applying the largest value seen is idempotent and order-independent.
 * Refunds are facts reported by Stripe, so they apply from any paid state.
 */
export function applyRefund(
	order: LiteOrder,
	refundedTotal: number,
	charge: Pick<StripeCharge, "amount" | "payment_intent">,
	now: number,
): LiteOrder | null {
	if (!["paid", "partially-refunded", "refunded"].includes(order.paymentStatus)) return null;
	if (
		charge.payment_intent &&
		order.stripePaymentIntentId &&
		charge.payment_intent !== order.stripePaymentIntentId
	) {
		return null;
	}
	if (refundedTotal <= (order.refundedAmount ?? 0)) return null;
	const paid = order.amountPaid ?? charge.amount ?? order.total.amount;
	const paymentStatus = derivePaymentStatus(paid, refundedTotal);
	const next: LiteOrder = {
		...order,
		refundedAmount: refundedTotal,
		refundedAt: new Date(now).toISOString(),
		paymentStatus,
		status:
			order.status === "cancelled" || order.status === "failed"
				? order.status
				: deriveOrderStatusFromRefunds(order.status, paid, refundedTotal),
	};
	if (paymentStatus === "refunded" && order.stock === "deducted") next.stock = "restored";
	return next;
}

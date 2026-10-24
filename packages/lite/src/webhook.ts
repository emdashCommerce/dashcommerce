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
 *   checkout.session.completed            paid -> mark paid, take stock
 *                                       unpaid -> on hold, awaiting a delayed
 *                                                 payment (ACH, SEPA debit)
 *   checkout.session.async_payment_succeeded     -> mark paid, take stock
 *   checkout.session.async_payment_failed        -> mark failed
 *   checkout.session.expired                     -> cancel pending order
 *   charge.refunded                              -> record refund; a full
 *                                                   refund restores stock
 *
 * An event id is recorded in `stripe_events` only after its side effects
 * are done or durably queued; a repeated delivery of a recorded id is
 * acknowledged without side effects. Until then a retry re-runs the event:
 * order writes are compare-and-set transitions, and the stock and cart
 * steps are idempotent (per-order, per-product stock ledger and
 * `paidEffectsAt`, see settle.ts), so a retry after a failure part-way
 * completes the missing steps exactly once.
 *
 * Subrequest budget (budget.ts): a paid event marks the order paid,
 * clears the cart and takes stock for as many lines as fit in the
 * request; the rest is taken by one-shot cron tasks, a few lines each
 * (settle.ts). The event is recorded once that follow-up task is
 * scheduled. A full refund restores stock the same way. Every webhook
 * request stays within 10 bridge calls, whatever the cart size.
 *
 * Only `pending` or `failed` orders (or ones on hold for a delayed payment)
 * can become paid. A refund for an order that is not paid yet answers 500
 * without recording the event, so Stripe delivers it again later.
 */

import type { PluginContext } from "emdash/plugin";
import { log, metered } from "./budget";
import { cartsStore } from "./cart";
import {
	fromStripeAddress,
	isAwaitingAsyncPayment,
	type LiteOrder,
	ordersStore,
	updateOrder,
} from "./orders";
import {
	deriveOrderStatusFromRefunds,
	derivePaymentStatus,
	money,
	type StripeCheckoutSession,
	verifyStripeSignature,
} from "./shared";
import { pendingLines, settleOrSchedule } from "./settle";

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

/**
 * Thrown when an event cannot be applied yet but will be later (for
 * example a refund that arrives before the payment). The webhook answers
 * 500 and does not record the event, so Stripe retries it.
 */
export class RetryLater extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "RetryLater";
	}
}

export const HANDLED_EVENTS = [
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"checkout.session.async_payment_failed",
	"checkout.session.expired",
	"charge.refunded",
] as const;

const HANDLED = new Set<string>(HANDLED_EVENTS);

export async function handleStripeWebhook(
	rawCtx: PluginContext,
	payload: unknown,
	headers: Record<string, string>,
	now = Date.now(),
): Promise<WebhookResult> {
	const ctx = metered(rawCtx);
	const secret = await ctx.settings.get<string>("stripeWebhookSecret");
	if (!secret) {
		log(ctx, "warn", "Stripe webhook received but no signing secret is configured");
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
		if (err instanceof RetryLater) {
			log(ctx, "info", "Stripe event deferred; Stripe will retry", {
				type: event.type,
				reason: err.reason,
			});
			return { status: 500, body: { error: "retry_later", reason: err.reason } };
		}
		log(ctx, "error", "Stripe webhook processing failed", {
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

	if (type === "checkout.session.completed" && session.payment_status === "unpaid") {
		// Delayed payment method: the shopper finished Checkout, the money
		// arrives later with async_payment_succeeded or _failed.
		const { order, written } = await updateOrder(
			store,
			orderId,
			(o) => (sessionMatches(o) ? markAwaitingAsyncPayment(o, session) : null),
			2,
		);
		if (!order) return "order_not_found";
		return written || isAwaitingAsyncPayment(order) ? "awaiting_async_payment" : "unchanged";
	}

	if (
		type === "checkout.session.completed" ||
		type === "checkout.session.async_payment_succeeded"
	) {
		if (session.payment_status !== "paid") return "awaiting_payment";
		const { order, written, revision } = await updateOrder(
			store,
			orderId,
			(o) => (sessionMatches(o) ? markPaid(o, session, now) : null),
			2,
		);
		if (!order) {
			log(ctx, "warn", "Stripe session references an unknown order", { orderId });
			return "order_not_found";
		}
		if (!written) {
			// Already paid by this session: a retry finishes side effects a
			// failed earlier attempt left undone. Anything else is a no-op.
			const paidBySession = Boolean(order.paidAt) && order.stripeSessionId === session.id;
			if (!paidBySession) {
				if (sessionMatches(order) && !order.paidAt) {
					log(ctx, "warn", "Payment for an order that can no longer be paid", {
						orderId,
						status: order.status,
					});
					return "not_payable";
				}
				return "unchanged";
			}
			if (order.paidEffectsAt) return "unchanged";
		}
		const settled = await completePaidEffects(ctx, orderId, order, revision, now);
		if (!settled.done) return "paid_stock_pending";
		if ((settled.order?.stockShortfall ?? []).length > 0) return "paid_stock_shortfall";
		return order.amountMismatch ? "paid_amount_mismatch" : "paid";
	}

	if (type === "checkout.session.async_payment_failed") {
		const { order, written } = await updateOrder(
			store,
			orderId,
			(o) => {
				if (!sessionMatches(o) || o.paymentStatus !== "pending") return null;
				if (o.status !== "pending" && !isAwaitingAsyncPayment(o)) return null;
				const { awaitingAsyncPayment: _awaiting, ...rest } = o;
				return { ...rest, status: "failed", paymentStatus: "failed" };
			},
			2,
		);
		if (!order) return "order_not_found";
		return written ? "failed" : "unchanged";
	}

	// checkout.session.expired
	const { order } = await updateOrder(
		store,
		orderId,
		(o) =>
			sessionMatches(o) && o.status === "pending" && o.paymentStatus === "pending"
				? { ...o, status: "cancelled", cancelReason: "session_expired" }
				: null,
		2,
	);
	return order ? "expired" : "order_not_found";
}

/**
 * Clear a newly paid order's cart, then take its items out of stock: as
 * many lines as fit in this request, the rest in follow-up cron tasks
 * (settle.ts). The settle pass sets `paidEffectsAt` when the last line is
 * taken. Each step is idempotent, so this is safe to run again after a
 * failure part-way. Keeps one call free for the event record.
 */
async function completePaidEffects(
	ctx: PluginContext,
	orderId: string,
	order: LiteOrder,
	revision: string | undefined,
	now: number,
) {
	await cartsStore(ctx).delete(order.cartId);
	return settleOrSchedule(ctx, orderId, {
		reserve: 1,
		current: revision ? { value: order, revision } : undefined,
		now,
	});
}

/** True when Stripe may move this order to paid. */
export function isPayable(order: LiteOrder): boolean {
	if (order.paymentStatus !== "pending" && order.paymentStatus !== "failed") return false;
	return order.status === "pending" || order.status === "failed" || isAwaitingAsyncPayment(order);
}

/**
 * Pure transition to "awaiting a delayed payment". Only from a pending
 * order; returns null otherwise (idempotent).
 */
export function markAwaitingAsyncPayment(
	order: LiteOrder,
	session: SessionWithExtras,
): LiteOrder | null {
	if (order.status !== "pending" || order.paymentStatus !== "pending") return null;
	const email = session.customer_details?.email ?? order.customerEmail;
	return {
		...order,
		status: "on-hold",
		awaitingAsyncPayment: true,
		stripeSessionId: session.id,
		...(session.payment_intent ? { stripePaymentIntentId: String(session.payment_intent) } : {}),
		...(email ? { customerEmail: email.toLowerCase() } : {}),
	};
}

/**
 * Pure transition to "paid". Only `pending` or `failed` orders (or ones on
 * hold for a delayed payment) can become paid; everything else returns
 * null, so a replayed event never moves a refunded, cancelled, on-hold or
 * already paid order. A charged amount that differs from the order total
 * puts the order on hold for the merchant instead of marking it
 * processing. With Stripe Tax, the expected amount is the order total plus
 * the tax Stripe reports in `total_details.amount_tax`.
 */
export function markPaid(
	order: LiteOrder,
	session: SessionWithExtras,
	now: number,
): LiteOrder | null {
	if (!isPayable(order)) return null;
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

	const { awaitingAsyncPayment: _awaiting, ...rest } = order;
	const next: LiteOrder = {
		...rest,
		status: mismatch ? "on-hold" : "processing",
		paymentStatus: "paid",
		paidAt: new Date(now).toISOString(),
		amountPaid: receivedAmount,
		stripeSessionId: session.id,
		...(session.payment_intent ? { stripePaymentIntentId: String(session.payment_intent) } : {}),
		...(email ? { customerEmail: email.toLowerCase() } : {}),
		...(address ? { shippingAddress: address } : {}),
		...(typeof session.livemode === "boolean" ? { livemode: session.livemode } : {}),
		...(tracked ? { stock: "deducted" as const, stockPending: 1 as const } : {}),
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
	const { order, written, revision } = await updateOrder(
		store,
		orderId,
		(o) => applyRefund(o, refunded, charge, now),
		2,
	);
	if (!order) return "order_not_found";
	if (order.paymentStatus === "pending" || order.paymentStatus === "failed") {
		// Stripe can deliver charge.refunded before the payment event. Do not
		// drop it: answer 500 without recording it, so Stripe retries.
		throw new RetryLater("refund_before_paid");
	}
	// Idempotent: also finishes a restore that failed or was deferred on an
	// earlier attempt. Lines that do not fit run in follow-up cron tasks.
	if (order.stock === "restored" && pendingLines(order).length > 0) {
		await settleOrSchedule(ctx, orderId, {
			reserve: 1,
			current: revision ? { value: order, revision } : undefined,
			now,
		});
	}
	if (!written) return "unchanged";
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
	if (paymentStatus === "refunded" && order.stock === "deducted") {
		next.stock = "restored";
		next.stockPending = 1;
	}
	return next;
}

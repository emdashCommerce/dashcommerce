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
 *   checkout.session.completed              paid -> mark paid
 *   checkout.session.async_payment_succeeded       -> mark paid
 *   checkout.session.async_payment_failed          -> mark failed
 *   checkout.session.expired                       -> cancel pending order
 *
 * Every processed event id is recorded in `stripe_events`; a repeated
 * delivery is acknowledged without side effects. Order writes use
 * compare-and-set, so concurrent duplicate deliveries are also safe.
 */

import type { PluginContext } from "emdash/plugin";
import { cartKey } from "./cart";
import { fromStripeAddress, type LiteOrder, ordersStore, updateOrder } from "./orders";
import { type StripeCheckoutSession, verifyStripeSignature } from "./shared";

export interface WebhookResult {
	status: number;
	body: Record<string, unknown>;
}

interface StripeEvent {
	id: string;
	type: string;
	data: { object: Record<string, unknown> };
}

type EventsStore = {
	exists(id: string): Promise<boolean>;
	put(id: string, data: Record<string, unknown>): Promise<void>;
};

const HANDLED = new Set([
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"checkout.session.async_payment_failed",
	"checkout.session.expired",
]);

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
		outcome = await processSessionEvent(
			ctx,
			event.type,
			event.data.object as unknown as StripeCheckoutSession,
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
	session: StripeCheckoutSession,
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
		if (written) {
			// Payment confirmed: the cart has been bought, so empty it.
			await ctx.kv.delete(cartKey(order.cartId));
			return order.amountMismatch ? "paid_amount_mismatch" : "paid";
		}
		return "unchanged";
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
			? { ...o, status: "cancelled" }
			: null,
	);
	return order ? "expired" : "order_not_found";
}

/**
 * Pure transition to "paid". Returns null when the order is already paid
 * (idempotent). A charged amount that differs from the order total puts
 * the order on hold for the merchant instead of marking it processing.
 */
export function markPaid(
	order: LiteOrder,
	session: StripeCheckoutSession,
	now: number,
): LiteOrder | null {
	if (order.paymentStatus === "paid") return null;
	const receivedCurrency = (session.currency ?? "").toUpperCase();
	const receivedAmount = session.amount_total ?? -1;
	const mismatch =
		receivedAmount !== order.total.amount || receivedCurrency !== order.total.currency;

	const collected = (
		session as {
			collected_information?: { shipping_details?: StripeCheckoutSession["shipping_details"] };
		}
	).collected_information?.shipping_details;
	const shipping = collected ?? session.shipping_details;
	const email = session.customer_details?.email ?? order.customerEmail;
	const address = fromStripeAddress(shipping?.name, shipping?.address);

	const next: LiteOrder = {
		...order,
		status: mismatch ? "on-hold" : "processing",
		paymentStatus: "paid",
		paidAt: new Date(now).toISOString(),
		stripeSessionId: session.id,
		...(session.payment_intent ? { stripePaymentIntentId: String(session.payment_intent) } : {}),
		...(email ? { customerEmail: email } : {}),
		...(address ? { shippingAddress: address } : {}),
	};
	if (mismatch) {
		next.amountMismatch = {
			expected: order.total,
			received: { currency: receivedCurrency, amount: receivedAmount },
		};
	}
	return next;
}

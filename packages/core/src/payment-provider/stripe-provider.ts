/**
 * StripePaymentProvider — Stripe implementing the PaymentProvider
 * interface (see ./types.ts's module comment for why this fork exists).
 *
 * This is a thin adapter over the EXISTING `../stripe/*` modules —
 * deliberately not a rewrite. Keeping `../stripe/*` untouched (beyond
 * this wrapper) is what keeps the upstream diff minimal and PR-able: a
 * maintainer reviewing "introduce PaymentProvider, refactor Stripe onto
 * it" should see `stripe/*` unchanged and a new adapter file, not a
 * reshuffle of working, already-tested code.
 */

import type { PluginContext } from "emdash";
import type {
	CreateRefundInput,
	InitCheckoutInput,
	InitCheckoutResult,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderCredentials,
	PaymentProviderRuntimeContext,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "./types";
import {
	createCheckoutSession,
	type CheckoutLineItem,
	type StripeCheckoutSession,
} from "../stripe/checkout-sessions";
import { verifyStripeSignature } from "../stripe/webhook-verify";
import { createRefund as stripeCreateRefund } from "../stripe/refunds";
import type { StripeClientOptions } from "../stripe/client";
import type { StripePaymentIntent } from "../stripe/payment-intents";

function toStripeClient(credentials: PaymentProviderCredentials): StripeClientOptions {
	return { secretKey: credentials.secretKey };
}

/** Cast our narrow PaymentProviderRuntimeContext to the wider PluginContext
 * the existing `../stripe/*` helpers expect. Safe: every stripe/* function
 * only ever touches `ctx.http`, which our runtime context always provides —
 * this cast exists purely to avoid rewriting the tested stripe/* call
 * signatures for this adapter. */
function asPluginContext(ctx: PaymentProviderRuntimeContext): PluginContext {
	return ctx as unknown as PluginContext;
}

export const stripePaymentProvider: PaymentProvider = {
	id: "stripe",
	label: "Stripe",

	supportedCurrencies(): string[] {
		// Stripe supports 135+ currencies; Kenya isn't onboardable as a
		// Stripe merchant account today (SPEC.md §3, "Stripe doesn't
		// onboard Kenyan businesses") but Stripe can still charge in KES
		// for a non-Kenya-domiciled Stripe account. We don't restrict the
		// list here — the merchant's own Stripe account dictates what's
		// actually chargeable, and Stripe's API rejects unsupported
		// currencies at request time with a clear error.
		return ["*"];
	},

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const client = toStripeClient(credentials);
		const lineItems: CheckoutLineItem[] = input.lineItems.map((li) => ({
			amount: li.amount,
			currency: li.currency.toLowerCase(),
			name: li.name,
			description: li.description,
			quantity: li.quantity,
			metadata: li.metadata,
		}));

		const session: StripeCheckoutSession = await createCheckoutSession(
			asPluginContext(ctx),
			{
				mode: "payment",
				successUrl: input.successUrl,
				cancelUrl: input.cancelUrl,
				lineItems,
				customerEmail: input.customer.email,
				clientReferenceId: input.orderDraftId,
				metadata: { orderDraftId: input.orderDraftId, ...input.metadata },
				paymentIntentMetadata: { orderDraftId: input.orderDraftId, ...input.metadata },
				paymentIntentReceiptEmail: input.customer.email,
			},
			client,
			`cs:${input.orderDraftId}`,
		);

		if (!session.url) {
			throw new Error("Stripe did not return a hosted checkout URL");
		}

		return { providerReference: session.id, redirectUrl: session.url };
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		const result = await verifyStripeSignature({
			payload: input.rawBody,
			signatureHeader: input.signatureHeader,
			secret: input.secret,
		});
		return { ok: result.ok, reason: result.reason };
	},

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let event: { type: string; data: { object: unknown } };
		try {
			event = JSON.parse(rawBody);
		} catch {
			return { type: "unhandled", providerEventType: "unparseable", raw: rawBody };
		}

		if (event.type === "checkout.session.completed") {
			const session = event.data.object as StripeCheckoutSession;
			const orderDraftId = session.metadata?.orderDraftId ?? session.client_reference_id;
			if (!orderDraftId) {
				return { type: "unhandled", providerEventType: event.type, raw: event };
			}
			return {
				type: "charge.succeeded",
				orderDraftId,
				providerReference: session.id,
				amount: session.amount_total ?? 0,
				currency: (session.currency ?? "usd").toUpperCase(),
				customer: {
					email: session.customer_details?.email ?? "",
					name: session.customer_details?.name,
					phone: session.customer_details?.phone,
				},
				shippingAddress: session.shipping_details?.address
					? {
							line1: session.shipping_details.address.line1 ?? undefined,
							line2: session.shipping_details.address.line2 ?? undefined,
							city: session.shipping_details.address.city ?? undefined,
							state: session.shipping_details.address.state ?? undefined,
							postalCode: session.shipping_details.address.postal_code ?? undefined,
							country: session.shipping_details.address.country ?? undefined,
						}
					: undefined,
				channel: "Card",
				raw: event,
			};
		}

		if (
			event.type === "payment_intent.payment_failed" ||
			event.type === "payment_intent.canceled"
		) {
			const pi = event.data.object as StripePaymentIntent;
			const orderDraftId = pi.metadata?.orderDraftId;
			if (!orderDraftId) {
				return { type: "unhandled", providerEventType: event.type, raw: event };
			}
			return {
				type: "charge.failed",
				orderDraftId,
				providerReference: pi.id,
				raw: event,
			};
		}

		return { type: "unhandled", providerEventType: event.type, raw: event };
	},

	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		const client = toStripeClient(credentials);
		const refund = await stripeCreateRefund(
			asPluginContext(ctx),
			{ paymentIntent: input.providerReference, amount: input.amount },
			client,
			`refund:${input.providerReference}:${input.amount ?? "full"}`,
		);
		return {
			providerRefundId: refund.id,
			status:
				refund.status === "succeeded"
					? "succeeded"
					: refund.status === "failed"
						? "failed"
						: "pending",
			amount: refund.amount,
			currency: refund.currency.toUpperCase(),
		};
	},

	formatAmount(money): string {
		const major = (money.amount / 100).toFixed(2);
		return `${money.currency.toUpperCase()} ${major}`;
	},
};

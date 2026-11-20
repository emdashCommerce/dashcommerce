/**
 * Stripe adapter implementing PaymentProvider.
 *
 * Wraps existing `src/stripe/*` helpers. Does not change those modules.
 * `initCheckout` maps the full hosted-Checkout input (shipping, tax,
 * subscriptions, Connect) onto `createCheckoutSession`. `refund` takes a
 * PaymentIntent id (`paymentReference`) and never a Checkout Session id.
 */

import type { PluginContext } from "emdash";
import { format, money } from "../money";
import {
	type CheckoutLineItem,
	type CreateCheckoutSessionInput,
	type StripeCheckoutSession,
	createCheckoutSession,
} from "../stripe/checkout-sessions";
import type { StripeClientOptions } from "../stripe/client";
import { type StripePaymentIntent, retrievePaymentIntent } from "../stripe/payment-intents";
import { createRefund as stripeCreateRefund } from "../stripe/refunds";
import { verifyStripeSignature } from "../stripe/webhook-verify";
import { addressFromProviderSession, withBillingShippingFallback } from "./addresses";
import type {
	CreateRefundInput,
	InitCheckoutInput,
	InitCheckoutResult,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderCredentials,
	PaymentProviderRuntimeContext,
	PaymentStatusResult,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "./types";

function stripeRefundReason(reason?: string): "duplicate" | "fraudulent" | "requested_by_customer" {
	if (reason === "duplicate" || reason === "fraudulent" || reason === "requested_by_customer") {
		return reason;
	}
	return "requested_by_customer";
}

function toStripeClient(credentials: PaymentProviderCredentials): StripeClientOptions {
	return { secretKey: credentials.secretKey };
}

function asPluginContext(ctx: PaymentProviderRuntimeContext): PluginContext {
	if (!ctx.http) {
		throw new Error("Stripe PaymentProvider requires ctx.http.fetch");
	}
	return ctx as unknown as PluginContext;
}

function mapLineItems(input: InitCheckoutInput): CheckoutLineItem[] {
	return input.lineItems.map((li) => ({
		amount: li.amount,
		currency: li.currency.toLowerCase(),
		name: li.name,
		quantity: li.quantity,
		...(li.description ? { description: li.description } : {}),
		...(li.images ? { images: li.images } : {}),
		...(li.metadata ? { metadata: li.metadata } : {}),
		...(li.recurring
			? {
					recurring: {
						interval: li.recurring.interval,
						intervalCount: li.recurring.intervalCount,
					},
				}
			: {}),
		...(li.taxBehavior ? { taxBehavior: li.taxBehavior } : {}),
	}));
}

/**
 * Pure mapping from the gateway-agnostic input onto the existing Stripe
 * Checkout Session helper. Exported so tests can assert hosted-parity
 * (shipping, tax, subscriptions, Connect) without hitting the network.
 */
export function toCreateCheckoutSessionInput(input: InitCheckoutInput): CreateCheckoutSessionInput {
	const mode = input.mode ?? "payment";
	const isSubscription = mode === "subscription";

	const mapped: CreateCheckoutSessionInput = {
		mode,
		successUrl: input.successUrl,
		cancelUrl: input.cancelUrl,
		lineItems: mapLineItems(input),
		...(input.customer.email ? { customerEmail: input.customer.email } : {}),
		clientReferenceId: input.clientReferenceId ?? input.orderDraftId,
		billingAddressCollection: input.billingAddressCollection ?? "auto",
		allowPromotionCodes: input.allowPromotionCodes ?? false,
		metadata: { orderDraftId: input.orderDraftId, ...input.metadata },
	};

	if (input.shippingAddressCollection) {
		mapped.shippingAddressCollection = input.shippingAddressCollection;
	}
	if (input.shippingOptions && input.shippingOptions.length > 0) {
		mapped.shippingOptions = input.shippingOptions.map((s) => ({
			displayName: s.label,
			amount: s.amount,
			currency: s.currency.toLowerCase(),
			...(s.deliveryDays ? { deliveryDays: s.deliveryDays } : {}),
			...(s.metadata ? { metadata: s.metadata } : {}),
		}));
	}
	if (input.automaticTax) mapped.automaticTax = true;
	if (input.discounts && input.discounts.length > 0) mapped.discounts = input.discounts;

	if (isSubscription) {
		if (input.subscriptionMetadata) {
			mapped.subscriptionMetadata = input.subscriptionMetadata;
		}
		if (input.subscriptionTrialPeriodDays !== undefined) {
			mapped.subscriptionTrialPeriodDays = input.subscriptionTrialPeriodDays;
		}
	} else {
		mapped.paymentIntentMetadata = {
			orderDraftId: input.orderDraftId,
			...input.paymentIntentMetadata,
		};
		if (input.paymentIntentReceiptEmail ?? input.customer.email) {
			mapped.paymentIntentReceiptEmail = input.paymentIntentReceiptEmail ?? input.customer.email;
		}
		if (input.transferData) mapped.paymentIntentTransferData = input.transferData;
		if (input.applicationFeeAmount !== undefined) {
			mapped.paymentIntentApplicationFeeAmount = input.applicationFeeAmount;
		}
	}

	return mapped;
}

function unhandled(
	providerEventType: string,
	raw: unknown,
	providerEventId?: string,
): NormalizedPaymentEvent {
	return {
		type: "unhandled",
		providerEventType,
		...(providerEventId ? { providerEventId } : {}),
		raw,
	};
}

function parseStripeEvent(rawBody: string): {
	id?: string;
	type?: string;
	data?: { object: unknown };
} | null {
	try {
		return JSON.parse(rawBody) as {
			id?: string;
			type?: string;
			data?: { object: unknown };
		};
	} catch {
		return null;
	}
}

export const stripePaymentProvider: PaymentProvider = {
	id: "stripe",
	label: "Stripe",
	description: "Cards, wallets and local payment methods worldwide.",
	brandColour: "#635BFF",
	capabilities: {
		coupons: true,
		connect: true,
		subscriptions: true,
	},
	collectsCustomerDetails: true,

	supportsCurrency(currency: string): boolean {
		if (!currency || typeof currency !== "string") return false;
		return /^[A-Z]{3}$/.test(currency.trim().toUpperCase());
	},

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const session = await createCheckoutSession(
			asPluginContext(ctx),
			toCreateCheckoutSessionInput(input),
			toStripeClient(credentials),
			`cs:${input.orderDraftId}`,
		);
		if (!session.url) {
			throw new Error("Stripe did not return a hosted checkout URL");
		}
		return {
			kind: "redirect",
			checkoutReference: session.id,
			redirectUrl: session.url,
		};
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		const result = await verifyStripeSignature({
			payload: input.rawBody,
			signatureHeader: input.signatureHeader,
			secret: input.secret,
		});
		return { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) };
	},

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		const event = parseStripeEvent(rawBody);
		if (!event) {
			return unhandled("unparseable", rawBody);
		}
		if (!event.type) {
			return unhandled("unknown", event, event.id);
		}

		const providerEventId = event.id;
		const sessionTypes = new Set([
			"checkout.session.completed",
			"checkout.session.async_payment_succeeded",
		]);

		if (sessionTypes.has(event.type)) {
			const session = event.data?.object as StripeCheckoutSession | undefined;
			const orderDraftId = session?.metadata?.orderDraftId ?? session?.client_reference_id;
			if (!session || !orderDraftId) {
				return unhandled(event.type, event, providerEventId);
			}
			if (session.mode === "subscription") {
				return unhandled(event.type, event, providerEventId);
			}
			if (session.payment_status !== "paid") {
				return unhandled(event.type, event, providerEventId);
			}
			if (!session.payment_intent) {
				// Never treat a Checkout Session id as the refundable payment id.
				return unhandled(event.type, event, providerEventId);
			}
			if (!providerEventId) {
				return unhandled(event.type, event);
			}

			const billingAddress = addressFromProviderSession(
				session.customer_details?.name,
				session.customer_details?.address,
				session.customer_details?.phone,
			);
			const shippingAddress = addressFromProviderSession(
				session.shipping_details?.name ?? session.customer_details?.name,
				session.shipping_details?.address ?? session.customer_details?.address,
				session.shipping_details?.phone ?? session.customer_details?.phone,
			);
			const resolved = withBillingShippingFallback(billingAddress, shippingAddress);

			return {
				type: "charge.succeeded",
				orderDraftId,
				providerId: "stripe",
				providerEventId,
				checkoutReference: session.id,
				paymentReference: session.payment_intent,
				amount: session.amount_total ?? 0,
				currency: (session.currency ?? "usd").toUpperCase(),
				customer: {
					email: session.customer_details?.email ?? "",
					name: session.customer_details?.name,
					phone: session.customer_details?.phone,
				},
				...resolved,
				channel: "card",
				raw: event,
			};
		}

		if (event.type === "payment_intent.succeeded") {
			const pi = event.data?.object as StripePaymentIntent | undefined;
			const orderDraftId = pi?.metadata?.orderDraftId;
			if (!pi || !orderDraftId || !providerEventId) {
				return unhandled(event.type, event, providerEventId);
			}
			return {
				type: "charge.succeeded",
				orderDraftId,
				providerId: "stripe",
				providerEventId,
				paymentReference: pi.id,
				amount: typeof pi.amount_received === "number" ? pi.amount_received : pi.amount,
				currency: (pi.currency ?? "usd").toUpperCase(),
				customer: { email: pi.receipt_email ?? "" },
				raw: event,
			};
		}

		if (
			event.type === "payment_intent.payment_failed" ||
			event.type === "payment_intent.canceled"
		) {
			const pi = event.data?.object as StripePaymentIntent | undefined;
			const orderDraftId = pi?.metadata?.orderDraftId;
			if (!pi || !orderDraftId || !providerEventId) {
				return unhandled(event.type, event, providerEventId);
			}
			return {
				type: "charge.failed",
				orderDraftId,
				providerId: "stripe",
				providerEventId,
				paymentReference: pi.id,
				reason: (pi as { last_payment_error?: { message?: string } }).last_payment_error?.message,
				raw: event,
			};
		}

		return unhandled(event.type, event, providerEventId);
	},

	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		const paymentReference = input.paymentReference?.trim() ?? "";
		const refundRequestId = input.refundRequestId?.trim() ?? "";
		if (!paymentReference) {
			throw new Error("Stripe refund requires paymentReference (PaymentIntent id)");
		}
		if (paymentReference.startsWith("cs_")) {
			throw new Error(
				"Stripe refund requires a PaymentIntent id (paymentReference), not a Checkout Session id",
			);
		}
		if (!refundRequestId) {
			throw new Error("Stripe refund requires refundRequestId for idempotency");
		}

		const refund = await stripeCreateRefund(
			asPluginContext(ctx),
			{
				paymentIntent: paymentReference,
				amount: input.amount,
				reason: stripeRefundReason(input.reason),
				...(input.metadata ? { metadata: input.metadata } : {}),
			},
			toStripeClient(credentials),
			refundRequestId,
		);
		return {
			providerRefundId: refund.id,
			refundRequestId,
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

	formatAmount(amount: number, currency: string): string {
		return format(money(currency, amount));
	},

	async getPaymentStatus(
		ctx: PaymentProviderRuntimeContext,
		paymentReference: string,
		credentials: PaymentProviderCredentials,
	): Promise<PaymentStatusResult> {
		const pi = await retrievePaymentIntent(
			asPluginContext(ctx),
			paymentReference,
			toStripeClient(credentials),
		);
		const amount = typeof pi.amount_received === "number" ? pi.amount_received : pi.amount;
		const status: PaymentStatusResult["status"] =
			pi.status === "succeeded"
				? "succeeded"
				: pi.status === "canceled" || pi.status === "payment_failed"
					? "failed"
					: "pending";
		return {
			status,
			paymentReference: pi.id,
			amount,
			currency: (pi.currency ?? "").toUpperCase(),
			...(status !== "succeeded" ? { reason: `stripe status ${pi.status}` } : {}),
		};
	},
};

/**
 * Stripe Checkout Session helpers.
 *
 * Checkout Sessions are Stripe-hosted payment pages. We build them when the
 * merchant has `settings:checkoutMode === "hosted"` — the customer is
 * redirected to stripe.com, enters card + address + billing there, and is
 * redirected back to `success_url`. This keeps card data and most PII
 * entirely off our infrastructure (SAQ-A).
 *
 * Post-payment, Stripe fires `checkout.session.completed` (and also the
 * usual `payment_intent.succeeded`); see `routes/webhook.ts` for the
 * session-completion handler that merges `customer_details` /
 * `shipping_details` back onto our cart snapshot and creates the order.
 *
 * Only the fields DashCommerce sends/reads are modeled — Stripe returns a
 * much larger object that webhook handlers can inspect via the raw event
 * payload.
 */

import type { PluginContext } from "emdash";
import { call, type StripeClientOptions } from "./client";

export interface CheckoutLineItem {
	/** Integer minor units (e.g. cents). */
	amount: number;
	/** Lowercase ISO-4217. */
	currency: string;
	name: string;
	description?: string;
	images?: string[];
	quantity: number;
	/** Arbitrary string metadata copied onto the created Product. */
	metadata?: Record<string, string>;
	/**
	 * Subscription pricing. Setting this turns the line into a recurring
	 * price — Stripe enforces that the session `mode` must be
	 * "subscription" and that every line item on the session is recurring
	 * (or all one-off for payment mode).
	 */
	recurring?: {
		interval: "day" | "week" | "month" | "year";
		intervalCount: number;
	};
	/**
	 * Stripe Tax behaviour for this line. "exclusive" means the amount
	 * is pre-tax and Stripe adds tax on top; "inclusive" means tax is
	 * already baked in. Only meaningful when the session has
	 * `automaticTax` enabled.
	 */
	taxBehavior?: "inclusive" | "exclusive";
}

export interface CheckoutShippingOption {
	displayName: string;
	/** Integer minor units in the same currency as the session. */
	amount: number;
	currency: string;
	/** Optional delivery window for display on Stripe's page. */
	deliveryDays?: { minimum: number; maximum?: number };
	/** Copied onto the resulting shipping_rate so we can reconcile on the webhook. */
	metadata?: Record<string, string>;
}

export interface CreateCheckoutSessionInput {
	mode: "payment" | "subscription" | "setup";
	/** `{CHECKOUT_SESSION_ID}` is a Stripe template token — leave as-is if you want it filled. */
	successUrl: string;
	cancelUrl: string;
	lineItems: CheckoutLineItem[];
	/** Preset on the hosted page; customer can still change on their side. */
	customerEmail?: string;
	/** ISO-2 country list Stripe will allow. If omitted, Stripe prompts the shopper without filtering. */
	shippingAddressCollection?: { allowedCountries: string[] };
	/** Rate shown on the hosted page. Pass a single option when the method was already chosen pre-redirect. */
	shippingOptions?: CheckoutShippingOption[];
	allowPromotionCodes?: boolean;
	clientReferenceId?: string;
	metadata?: Record<string, string>;
	/** Metadata copied onto the PaymentIntent Stripe creates for this session. */
	paymentIntentMetadata?: Record<string, string>;
	/** Sent as the PI's receipt_email. */
	paymentIntentReceiptEmail?: string;
	/** Connect direct-charge routing. */
	paymentIntentTransferData?: { destination: string; amount?: number };
	paymentIntentApplicationFeeAmount?: number;
	/** Enables Stripe Tax on the hosted page. Uses the account's tax configuration. */
	automaticTax?: boolean;
	/** When true, Stripe also collects a separate billing address. Default on Stripe's side. */
	billingAddressCollection?: "auto" | "required";
	/** Metadata copied onto the Subscription Stripe creates for `mode=subscription` sessions. */
	subscriptionMetadata?: Record<string, string>;
	/** Trial period for `mode=subscription` sessions. */
	subscriptionTrialPeriodDays?: number;
}

export interface StripeCheckoutSession {
	id: string;
	object: "checkout.session";
	mode: string;
	status?: string;
	payment_status?: string;
	url?: string;
	payment_intent?: string;
	customer?: string;
	customer_email?: string;
	subscription?: string;
	client_reference_id?: string;
	metadata?: Record<string, string>;
	amount_total?: number;
	currency?: string;
	customer_details?: {
		email?: string;
		name?: string;
		phone?: string;
		address?: StripeSessionAddress;
		tax_ids?: Array<{ type: string; value: string }>;
	};
	shipping_details?: {
		name?: string;
		phone?: string;
		address?: StripeSessionAddress;
	};
	shipping_cost?: {
		amount_total?: number;
		shipping_rate?: string;
	};
}

export interface StripeSessionAddress {
	line1?: string | null;
	line2?: string | null;
	city?: string | null;
	state?: string | null;
	postal_code?: string | null;
	country?: string | null;
}

export async function createCheckoutSession(
	ctx: PluginContext,
	input: CreateCheckoutSessionInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripeCheckoutSession> {
	const params: Record<string, unknown> = {
		mode: input.mode,
		success_url: input.successUrl,
		cancel_url: input.cancelUrl,
	};

	input.lineItems.forEach((li, i) => {
		params[`line_items[${i}][quantity]`] = li.quantity;
		params[`line_items[${i}][price_data][currency]`] = li.currency.toLowerCase();
		params[`line_items[${i}][price_data][unit_amount]`] = li.amount;
		params[`line_items[${i}][price_data][product_data][name]`] = li.name;
		if (li.description) {
			params[`line_items[${i}][price_data][product_data][description]`] = li.description;
		}
		(li.images ?? []).slice(0, 8).forEach((url, idx) => {
			params[`line_items[${i}][price_data][product_data][images][${idx}]`] = url;
		});
		if (li.metadata) {
			for (const [k, v] of Object.entries(li.metadata)) {
				params[`line_items[${i}][price_data][product_data][metadata][${k}]`] = v;
			}
		}
		if (li.recurring) {
			params[`line_items[${i}][price_data][recurring][interval]`] = li.recurring.interval;
			params[`line_items[${i}][price_data][recurring][interval_count]`] = li.recurring.intervalCount;
		}
		if (li.taxBehavior) {
			params[`line_items[${i}][price_data][tax_behavior]`] = li.taxBehavior;
		}
	});

	if (input.customerEmail) params.customer_email = input.customerEmail;
	if (input.clientReferenceId) params.client_reference_id = input.clientReferenceId;
	if (input.allowPromotionCodes) params.allow_promotion_codes = true;
	if (input.billingAddressCollection) {
		params.billing_address_collection = input.billingAddressCollection;
	}
	if (input.automaticTax) params["automatic_tax[enabled]"] = true;

	if (input.shippingAddressCollection) {
		input.shippingAddressCollection.allowedCountries.forEach((c, i) => {
			params[`shipping_address_collection[allowed_countries][${i}]`] = c.toUpperCase();
		});
	}

	(input.shippingOptions ?? []).forEach((opt, i) => {
		const base = `shipping_options[${i}][shipping_rate_data]`;
		params[`${base}[type]`] = "fixed_amount";
		params[`${base}[display_name]`] = opt.displayName;
		params[`${base}[fixed_amount][amount]`] = opt.amount;
		params[`${base}[fixed_amount][currency]`] = opt.currency.toLowerCase();
		if (opt.deliveryDays) {
			params[`${base}[delivery_estimate][minimum][unit]`] = "business_day";
			params[`${base}[delivery_estimate][minimum][value]`] = opt.deliveryDays.minimum;
			if (opt.deliveryDays.maximum !== undefined) {
				params[`${base}[delivery_estimate][maximum][unit]`] = "business_day";
				params[`${base}[delivery_estimate][maximum][value]`] = opt.deliveryDays.maximum;
			}
		}
		if (opt.metadata) {
			for (const [k, v] of Object.entries(opt.metadata)) {
				params[`${base}[metadata][${k}]`] = v;
			}
		}
	});

	if (input.metadata) {
		for (const [k, v] of Object.entries(input.metadata)) {
			params[`metadata[${k}]`] = v;
		}
	}

	// Subscription plumbing — only valid for mode=subscription.
	if (input.mode === "subscription") {
		if (input.subscriptionMetadata) {
			for (const [k, v] of Object.entries(input.subscriptionMetadata)) {
				params[`subscription_data[metadata][${k}]`] = v;
			}
		}
		if (input.subscriptionTrialPeriodDays !== undefined) {
			params["subscription_data[trial_period_days]"] = input.subscriptionTrialPeriodDays;
		}
	}

	// PaymentIntent plumbing is only valid for mode=payment. Stripe rejects
	// these fields on subscription sessions.
	if (input.mode === "payment") {
		if (input.paymentIntentMetadata) {
			for (const [k, v] of Object.entries(input.paymentIntentMetadata)) {
				params[`payment_intent_data[metadata][${k}]`] = v;
			}
		}
		if (input.paymentIntentReceiptEmail) {
			params["payment_intent_data[receipt_email]"] = input.paymentIntentReceiptEmail;
		}
		if (input.paymentIntentTransferData) {
			params["payment_intent_data[transfer_data][destination]"] =
				input.paymentIntentTransferData.destination;
			if (input.paymentIntentTransferData.amount !== undefined) {
				params["payment_intent_data[transfer_data][amount]"] =
					input.paymentIntentTransferData.amount;
			}
		}
		if (input.paymentIntentApplicationFeeAmount !== undefined) {
			params["payment_intent_data[application_fee_amount]"] =
				input.paymentIntentApplicationFeeAmount;
		}
	}

	return call<StripeCheckoutSession>(ctx, {
		method: "POST",
		path: "/checkout/sessions",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

export async function retrieveCheckoutSession(
	ctx: PluginContext,
	id: string,
	client: StripeClientOptions,
): Promise<StripeCheckoutSession> {
	return call<StripeCheckoutSession>(ctx, {
		method: "GET",
		path: `/checkout/sessions/${encodeURIComponent(id)}`,
		client,
	});
}

// =============================================================================
// Billing Portal (customer self-service for subscriptions + payment methods)
// =============================================================================
//
// The Billing Portal is a Stripe-hosted page where customers can update
// cards, cancel/resume subscriptions, download invoices, etc. We hand out
// a short-lived portal URL per request — the portal itself handles auth
// by binding the session to a specific Stripe Customer id.

export interface BillingPortalSession {
	id: string;
	url: string;
	customer: string;
	return_url: string;
}

export interface CreateBillingPortalSessionInput {
	customer: string;
	returnUrl: string;
	/** Optional — pins the session to a specific portal configuration. */
	configuration?: string;
}

export async function createBillingPortalSession(
	ctx: PluginContext,
	input: CreateBillingPortalSessionInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<BillingPortalSession> {
	const params: Record<string, unknown> = {
		customer: input.customer,
		return_url: input.returnUrl,
	};
	if (input.configuration) params.configuration = input.configuration;
	return call<BillingPortalSession>(ctx, {
		method: "POST",
		path: "/billing_portal/sessions",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

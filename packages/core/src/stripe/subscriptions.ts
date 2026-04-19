/**
 * Stripe Subscriptions + Invoices + Prices API.
 *
 * We read webhooks far more than we write — most lifecycle state changes
 * arrive via `customer.subscription.*` events and land in our
 * `subscriptions` storage. We only write to Stripe when:
 *
 *   - Customer self-service cancels / pauses / resumes a sub
 *   - Merchant changes plan (retriggers proration)
 *   - We need to create a Price on the fly at first-checkout (absent a
 *     pre-provisioned `subscriptionConfig.stripePriceId`)
 */

import type { PluginContext } from "emdash";
import { call, type StripeClientOptions } from "./client";

export interface StripeSubscription {
	id: string;
	customer: string;
	status:
		| "active"
		| "trialing"
		| "past_due"
		| "canceled"
		| "unpaid"
		| "incomplete"
		| "incomplete_expired"
		| "paused";
	current_period_start: number; // unix seconds
	current_period_end: number;
	trial_end?: number | null;
	cancel_at_period_end: boolean;
	canceled_at?: number | null;
	metadata?: Record<string, string>;
	pause_collection?: {
		behavior: "keep_as_draft" | "mark_uncollectible" | "void";
		resumes_at?: number;
	} | null;
	items: {
		data: Array<{
			id: string;
			quantity: number;
			price: { id: string; currency: string; unit_amount: number; recurring?: { interval: string; interval_count: number } };
		}>;
	};
	latest_invoice?: string;
}

export interface StripeInvoice {
	id: string;
	subscription?: string;
	customer?: string;
	status: "draft" | "open" | "paid" | "uncollectible" | "void";
	amount_paid: number;
	amount_due: number;
	currency: string;
	attempt_count: number;
	attempted: boolean;
	/**
	 * Why Stripe issued this invoice. "subscription_create" and
	 * "subscription" fire for the initial period which is already
	 * covered by the regular order receipt, so we want to skip renewal
	 * emails on those. Renewal is "subscription_cycle";
	 * "subscription_update" covers plan changes mid-period.
	 */
	billing_reason?:
		| "manual"
		| "upcoming"
		| "subscription_create"
		| "subscription_cycle"
		| "subscription_update"
		| "subscription_threshold"
		| "subscription"
		| "quote_accept"
		| "automatic_pending_invoice_item_invoice"
		| string;
	next_payment_attempt?: number | null;
	period_start?: number;
	period_end?: number;
	paid?: boolean;
	hosted_invoice_url?: string | null;
}

export interface StripePrice {
	id: string;
	currency: string;
	unit_amount: number;
	recurring?: { interval: "day" | "week" | "month" | "year"; interval_count: number };
	product: string;
}

export interface CreateSubscriptionInput {
	customer: string;
	items: Array<{ price: string; quantity?: number }>;
	trialPeriodDays?: number;
	metadata?: Record<string, string>;
	defaultPaymentMethod?: string;
	expand?: string[];
}

export async function createSubscription(
	ctx: PluginContext,
	input: CreateSubscriptionInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripeSubscription> {
	const params: Record<string, unknown> = {
		customer: input.customer,
		items: input.items.map((it) => ({ price: it.price, quantity: it.quantity ?? 1 })),
	};
	if (input.trialPeriodDays !== undefined) params.trial_period_days = input.trialPeriodDays;
	if (input.metadata) params.metadata = input.metadata;
	if (input.defaultPaymentMethod) params.default_payment_method = input.defaultPaymentMethod;
	if (input.expand) params.expand = input.expand;
	return call<StripeSubscription>(ctx, {
		method: "POST",
		path: "/subscriptions",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

export async function retrieveSubscription(
	ctx: PluginContext,
	id: string,
	client: StripeClientOptions,
): Promise<StripeSubscription> {
	return call<StripeSubscription>(ctx, {
		method: "GET",
		path: `/subscriptions/${encodeURIComponent(id)}`,
		client,
	});
}

export interface UpdateSubscriptionInput {
	cancelAtPeriodEnd?: boolean;
	pauseCollection?: {
		behavior: "keep_as_draft" | "mark_uncollectible" | "void";
		resumesAt?: number;
	} | null;
	items?: Array<{ id?: string; price?: string; quantity?: number; deleted?: boolean }>;
	prorationBehavior?: "create_prorations" | "none" | "always_invoice";
	metadata?: Record<string, string>;
}

export async function updateSubscription(
	ctx: PluginContext,
	id: string,
	input: UpdateSubscriptionInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripeSubscription> {
	const params: Record<string, unknown> = {};
	if (input.cancelAtPeriodEnd !== undefined) {
		params.cancel_at_period_end = input.cancelAtPeriodEnd;
	}
	if (input.pauseCollection === null) {
		params.pause_collection = "";
	} else if (input.pauseCollection) {
		params.pause_collection = {
			behavior: input.pauseCollection.behavior,
			...(input.pauseCollection.resumesAt !== undefined
				? { resumes_at: input.pauseCollection.resumesAt }
				: {}),
		};
	}
	if (input.items) params.items = input.items;
	if (input.prorationBehavior) params.proration_behavior = input.prorationBehavior;
	if (input.metadata) params.metadata = input.metadata;
	return call<StripeSubscription>(ctx, {
		method: "POST",
		path: `/subscriptions/${encodeURIComponent(id)}`,
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

/** Cancel immediately. */
export async function cancelSubscription(
	ctx: PluginContext,
	id: string,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripeSubscription> {
	return call<StripeSubscription>(ctx, {
		method: "DELETE",
		path: `/subscriptions/${encodeURIComponent(id)}`,
		idempotencyKey,
		client,
	});
}

export interface CreatePriceInput {
	currency: string;
	unitAmount: number;
	recurring: { interval: "day" | "week" | "month" | "year"; intervalCount: number };
	product: string; // Stripe product id
}

export async function createPrice(
	ctx: PluginContext,
	input: CreatePriceInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripePrice> {
	const params: Record<string, unknown> = {
		currency: input.currency.toLowerCase(),
		unit_amount: input.unitAmount,
		product: input.product,
		recurring: {
			interval: input.recurring.interval,
			interval_count: input.recurring.intervalCount,
		},
	};
	return call<StripePrice>(ctx, {
		method: "POST",
		path: "/prices",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

export interface CreateProductInput {
	name: string;
	metadata?: Record<string, string>;
}

export interface StripeProduct {
	id: string;
	name: string;
}

export async function createProduct(
	ctx: PluginContext,
	input: CreateProductInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripeProduct> {
	const params: Record<string, unknown> = {
		name: input.name,
		...(input.metadata ? { metadata: input.metadata } : {}),
	};
	return call<StripeProduct>(ctx, {
		method: "POST",
		path: "/products",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

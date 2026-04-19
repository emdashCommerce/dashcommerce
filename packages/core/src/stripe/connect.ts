/**
 * Stripe Connect — Accounts, AccountLinks, Payouts.
 *
 * DashCommerce uses the Express account type by default: less branding
 * overhead than Standard, less compliance burden than Custom. Accounts
 * are created server-side; customers are redirected to Stripe-hosted
 * onboarding via an AccountLink.
 *
 * Transfers happen implicitly through `transfer_data` on the checkout
 * PaymentIntent (destination-charge model) — we don't call /transfers
 * directly at v1.0 because that requires the "platform" account to hold
 * balance, which conflicts with the simplest install shape.
 */

import type { PluginContext } from "emdash";
import { call, type StripeClientOptions } from "./client";

export interface StripeAccount {
	id: string;
	type?: "express" | "standard" | "custom";
	email?: string;
	details_submitted?: boolean;
	charges_enabled?: boolean;
	payouts_enabled?: boolean;
	metadata?: Record<string, string>;
}

export interface StripeAccountLink {
	object: "account_link";
	created: number;
	expires_at: number;
	url: string;
}

export interface StripePayout {
	id: string;
	amount: number;
	currency: string;
	arrival_date: number;
	status: "paid" | "pending" | "in_transit" | "canceled" | "failed";
	destination?: string;
	metadata?: Record<string, string>;
}

export interface CreateAccountInput {
	email: string;
	country?: string;
	type?: "express" | "standard";
	businessType?: "individual" | "company";
	metadata?: Record<string, string>;
	capabilities?: { cardPayments?: boolean; transfers?: boolean };
}

export async function createAccount(
	ctx: PluginContext,
	input: CreateAccountInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripeAccount> {
	const params: Record<string, unknown> = {
		type: input.type ?? "express",
		email: input.email,
	};
	if (input.country) params.country = input.country;
	if (input.businessType) params.business_type = input.businessType;
	if (input.metadata) params.metadata = input.metadata;
	const caps: Record<string, unknown> = {};
	if (input.capabilities?.cardPayments !== false) {
		caps.card_payments = { requested: true };
	}
	if (input.capabilities?.transfers !== false) {
		caps.transfers = { requested: true };
	}
	if (Object.keys(caps).length > 0) params.capabilities = caps;

	return call<StripeAccount>(ctx, {
		method: "POST",
		path: "/accounts",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

export async function retrieveAccount(
	ctx: PluginContext,
	id: string,
	client: StripeClientOptions,
): Promise<StripeAccount> {
	return call<StripeAccount>(ctx, {
		method: "GET",
		path: `/accounts/${encodeURIComponent(id)}`,
		client,
	});
}

export interface CreateAccountLinkInput {
	account: string;
	refreshUrl: string;
	returnUrl: string;
	type?: "account_onboarding" | "account_update";
}

export async function createAccountLink(
	ctx: PluginContext,
	input: CreateAccountLinkInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripeAccountLink> {
	const params: Record<string, unknown> = {
		account: input.account,
		refresh_url: input.refreshUrl,
		return_url: input.returnUrl,
		type: input.type ?? "account_onboarding",
	};
	return call<StripeAccountLink>(ctx, {
		method: "POST",
		path: "/account_links",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

export interface ListPayoutsInput {
	account: string;
	limit?: number;
	startingAfter?: string;
	arrivalDateGte?: number;
}

export async function listPayouts(
	ctx: PluginContext,
	input: ListPayoutsInput,
	client: StripeClientOptions,
): Promise<{ data: StripePayout[]; has_more: boolean }> {
	const params: Record<string, unknown> = {
		limit: input.limit ?? 20,
	};
	if (input.startingAfter) params.starting_after = input.startingAfter;
	if (input.arrivalDateGte !== undefined) {
		params["arrival_date[gte]"] = input.arrivalDateGte;
	}
	// Connected-account scope via Stripe-Account header.
	return call<{ data: StripePayout[]; has_more: boolean }>(ctx, {
		method: "GET",
		path: "/payouts",
		params: params as Record<string, never>,
		client: { ...client, stripeAccount: input.account },
	});
}

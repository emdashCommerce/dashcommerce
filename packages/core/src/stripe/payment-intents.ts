/**
 * Stripe PaymentIntent helpers.
 *
 * Only the fields DashCommerce reads are modeled. The full object is
 * passed through in the returned record so hooks/webhook handlers can
 * inspect metadata, receipt_email, etc.
 */

import type { PluginContext } from "emdash";
import { call, type StripeClientOptions } from "./client";

export interface CreatePaymentIntentInput {
	amount: number; // integer minor units
	currency: string;
	receiptEmail?: string;
	description?: string;
	customer?: string;
	metadata?: Record<string, string>;
	automaticPaymentMethods?: { enabled: boolean; allowRedirects?: "always" | "never" };
	applicationFeeAmount?: number;
	transferData?: { destination: string; amount?: number };
	statementDescriptor?: string;
}

export interface StripePaymentIntent {
	id: string;
	amount: number;
	amount_received?: number;
	currency: string;
	status: string;
	client_secret?: string;
	customer?: string;
	latest_charge?: string;
	metadata?: Record<string, string>;
	receipt_email?: string;
	payment_method_types?: string[];
}

export async function createPaymentIntent(
	ctx: PluginContext,
	input: CreatePaymentIntentInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripePaymentIntent> {
	const params: Record<string, unknown> = {
		amount: input.amount,
		currency: input.currency.toLowerCase(),
	};
	if (input.receiptEmail) params.receipt_email = input.receiptEmail;
	if (input.description) params.description = input.description;
	if (input.customer) params.customer = input.customer;
	if (input.metadata) params.metadata = input.metadata;
	if (input.automaticPaymentMethods) {
		params.automatic_payment_methods = {
			enabled: input.automaticPaymentMethods.enabled,
			...(input.automaticPaymentMethods.allowRedirects
				? { allow_redirects: input.automaticPaymentMethods.allowRedirects }
				: {}),
		};
	} else {
		params.automatic_payment_methods = { enabled: true };
	}
	if (input.applicationFeeAmount !== undefined) {
		params.application_fee_amount = input.applicationFeeAmount;
	}
	if (input.transferData) params.transfer_data = input.transferData;
	if (input.statementDescriptor) params.statement_descriptor = input.statementDescriptor;

	return call<StripePaymentIntent>(ctx, {
		method: "POST",
		path: "/payment_intents",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

export async function retrievePaymentIntent(
	ctx: PluginContext,
	id: string,
	client: StripeClientOptions,
): Promise<StripePaymentIntent> {
	return call<StripePaymentIntent>(ctx, {
		method: "GET",
		path: `/payment_intents/${encodeURIComponent(id)}`,
		client,
	});
}

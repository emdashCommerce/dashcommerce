/**
 * Stripe Refunds API helpers.
 *
 * Refunds are created against a PaymentIntent (or charge). Partial refunds
 * pass `amount`; full refunds omit it. We always include an Idempotency-Key
 * scoped to `{orderId}:{refundId}` so retried webhook-driven refund flows
 * don't double-issue.
 */

import type { PluginContext } from "emdash";
import { call, type StripeClientOptions } from "./client";

export interface CreateRefundInput {
	paymentIntent: string;
	/** Minor units. Omit for full refund. */
	amount?: number;
	reason?: "duplicate" | "fraudulent" | "requested_by_customer";
	metadata?: Record<string, string>;
	reverseTransfer?: boolean;
	refundApplicationFee?: boolean;
}

export interface StripeRefund {
	id: string;
	amount: number;
	currency: string;
	status: "pending" | "succeeded" | "failed" | "canceled" | "requires_action";
	payment_intent?: string;
	charge?: string;
	reason?: string;
	failure_reason?: string;
	metadata?: Record<string, string>;
}

export async function createRefund(
	ctx: PluginContext,
	input: CreateRefundInput,
	client: StripeClientOptions,
	idempotencyKey: string,
): Promise<StripeRefund> {
	const params: Record<string, unknown> = {
		payment_intent: input.paymentIntent,
	};
	if (input.amount !== undefined) params.amount = input.amount;
	if (input.reason) params.reason = input.reason;
	if (input.metadata) params.metadata = input.metadata;
	if (input.reverseTransfer !== undefined) params.reverse_transfer = input.reverseTransfer;
	if (input.refundApplicationFee !== undefined) {
		params.refund_application_fee = input.refundApplicationFee;
	}
	return call<StripeRefund>(ctx, {
		method: "POST",
		path: "/refunds",
		params: params as Record<string, never>,
		idempotencyKey,
		client,
	});
}

export async function retrieveRefund(
	ctx: PluginContext,
	id: string,
	client: StripeClientOptions,
): Promise<StripeRefund> {
	return call<StripeRefund>(ctx, {
		method: "GET",
		path: `/refunds/${encodeURIComponent(id)}`,
		client,
	});
}

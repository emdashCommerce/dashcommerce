/**
 * MockPaymentProvider — an in-memory PaymentProvider for tests and for
 * running the whole checkout flow with no real gateway credentials at
 * all. Used by this fork's own test suite and by
 * a gateway package (e.g. Paystack)'s fixture suite
 * (BUILD_PLAN.md §3: "no Paystack keys in env -> implement + unit-test
 * against recorded fixtures and a MockPaymentProvider").
 *
 * Deterministic: `initCheckout` always succeeds and returns a predictable
 * reference; webhook verification passes iff `secret === "test-secret"`
 * (matching whatever the test fixture sets up); refunds always succeed.
 * Nothing here talks to the network.
 */

import type {
	CreateRefundInput,
	InitCheckoutInput,
	InitCheckoutResult,
	Money,
	NormalizedPaymentEvent,
	PaymentProvider,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "./types";

export interface MockPaymentProviderOptions {
	/** Force initCheckout/refund to fail, for negative-path tests. */
	failInit?: boolean;
	failRefund?: boolean;
}

export function createMockPaymentProvider(
	options: MockPaymentProviderOptions = {},
): PaymentProvider {
	return {
		id: "mock",
		label: "Mock (test-only)",

		supportedCurrencies(): string[] {
			return ["KES", "USD"];
		},

		async initCheckout(_ctx, input: InitCheckoutInput): Promise<InitCheckoutResult> {
			if (options.failInit) {
				throw new Error("MockPaymentProvider: forced initCheckout failure");
			}
			return {
				providerReference: `mock_ref_${input.orderDraftId}`,
				redirectUrl: `${input.successUrl}&mock=1`,
			};
		},

		async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
			if (input.secret !== "test-secret") {
				return { ok: false, reason: "mock: secret mismatch" };
			}
			return { ok: true };
		},

		parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
			const event = JSON.parse(rawBody) as {
				type: string;
				orderDraftId?: string;
				providerReference?: string;
				amount?: number;
				currency?: string;
				email?: string;
			};
			if (event.type === "charge.succeeded") {
				return {
					type: "charge.succeeded",
					orderDraftId: event.orderDraftId ?? "",
					providerReference: event.providerReference ?? "mock_ref",
					amount: event.amount ?? 0,
					currency: event.currency ?? "KES",
					customer: { email: event.email ?? "test@example.com" },
					channel: "Mock",
					raw: event,
				};
			}
			if (event.type === "charge.failed") {
				return {
					type: "charge.failed",
					orderDraftId: event.orderDraftId ?? "",
					providerReference: event.providerReference ?? "mock_ref",
					raw: event,
				};
			}
			return { type: "unhandled", providerEventType: event.type, raw: event };
		},

		async refund(_ctx, input: CreateRefundInput): Promise<RefundResult> {
			if (options.failRefund) {
				throw new Error("MockPaymentProvider: forced refund failure");
			}
			return {
				providerRefundId: `mock_refund_${input.providerReference}`,
				status: "succeeded",
				amount: input.amount ?? 0,
				currency: input.currency,
			};
		},

		formatAmount(money: Money): string {
			return `${money.currency} ${(money.amount / 100).toFixed(2)}`;
		},
	};
}

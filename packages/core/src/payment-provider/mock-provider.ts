/**
 * In-memory PaymentProvider for tests and credential-free local checkout.
 */

import { format, money } from "../money";
import type {
	CreateRefundInput,
	InitCheckoutInput,
	InitCheckoutResult,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderCapabilities,
	PaymentStatusResult,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "./types";

export interface MockPaymentProviderOptions {
	id?: string;
	supportedCurrencies?: string[];
	failInit?: boolean;
	failRefund?: boolean;
	failVerifyWebhook?: boolean;
	asyncPendingCheckout?: boolean;
	capabilities?: PaymentProviderCapabilities;
	/** When set, `getPaymentStatus` is omitted so callers trust the webhook payload. */
	omitGetPaymentStatus?: boolean;
	getPaymentStatusResult?: PaymentStatusResult;
	/** Declare on-page checkout and return `on_page` results when asked. */
	onPageCheckout?: boolean;
}

function appendQueryParam(urlString: string, key: string, value: string): string {
	const url = new URL(urlString);
	url.searchParams.set(key, value);
	return url.toString();
}

export function createMockPaymentProvider(
	options: MockPaymentProviderOptions = {},
): PaymentProvider {
	const providerId = options.id ?? "mock";
	const supported = (options.supportedCurrencies ?? ["KES", "USD"]).map((c) =>
		c.trim().toUpperCase(),
	);

	return {
		id: providerId,
		label: `Mock (${providerId})`,
		...(options.capabilities ? { capabilities: options.capabilities } : {}),
		...(options.onPageCheckout ? { checkoutStyles: ["hosted", "on_page"] as const } : {}),

		supportsCurrency(currency: string): boolean {
			if (!currency || typeof currency !== "string") return false;
			return supported.includes(currency.trim().toUpperCase());
		},

		async initCheckout(_ctx, input: InitCheckoutInput): Promise<InitCheckoutResult> {
			if (options.failInit) {
				throw new Error("MockPaymentProvider: forced initCheckout failure");
			}
			const checkoutReference = `mock_ref_${input.orderDraftId}`;
			if (options.onPageCheckout && input.checkoutStyle === "on_page") {
				return { kind: "on_page", checkoutReference, client: { reference: checkoutReference } };
			}
			if (options.asyncPendingCheckout) {
				return { kind: "pending", checkoutReference };
			}
			return {
				kind: "redirect",
				checkoutReference,
				redirectUrl: appendQueryParam(input.successUrl, "mock", "1"),
			};
		},

		async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
			if (options.failVerifyWebhook || input.signatureHeader === "invalid") {
				return { ok: false, reason: "mock: signature verification failed" };
			}
			if (input.secret !== "test-secret") {
				return { ok: false, reason: "mock: secret mismatch" };
			}
			return { ok: true };
		},

		parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
			let event: {
				id?: string;
				type?: string;
				orderDraftId?: string;
				paymentReference?: string;
				checkoutReference?: string;
				amount?: number;
				currency?: string;
				email?: string;
			};
			try {
				event = JSON.parse(rawBody) as typeof event;
			} catch {
				return {
					type: "unhandled",
					providerEventType: "unparseable",
					raw: rawBody,
				};
			}

			if (!event || typeof event !== "object" || !event.type) {
				return {
					type: "unhandled",
					providerEventType: "unknown",
					raw: event,
				};
			}

			const providerEventId = event.id;
			const paymentReference = event.paymentReference ?? "mock_pay_ref";
			const checkoutReference =
				event.checkoutReference ?? `mock_cs_${event.orderDraftId ?? "draft"}`;

			if (event.type === "charge.succeeded") {
				if (!providerEventId) {
					return {
						type: "unhandled",
						providerEventType: event.type,
						raw: event,
					};
				}
				return {
					type: "charge.succeeded",
					orderDraftId: event.orderDraftId ?? "",
					providerId,
					providerEventId,
					checkoutReference,
					paymentReference,
					amount: event.amount ?? 0,
					currency: event.currency ?? "KES",
					customer: { email: event.email ?? "test@example.com" },
					channel: "Mock",
					raw: event,
				};
			}

			if (event.type === "charge.failed") {
				if (!providerEventId) {
					return {
						type: "unhandled",
						providerEventType: event.type,
						raw: event,
					};
				}
				return {
					type: "charge.failed",
					orderDraftId: event.orderDraftId ?? "",
					providerId,
					providerEventId,
					checkoutReference,
					paymentReference,
					reason: "Mock payment failure",
					raw: event,
				};
			}

			return {
				type: "unhandled",
				providerEventType: event.type,
				...(providerEventId ? { providerEventId } : {}),
				raw: event,
			};
		},

		async refund(_ctx, input: CreateRefundInput): Promise<RefundResult> {
			if (options.failRefund) {
				throw new Error("MockPaymentProvider: forced refund failure");
			}
			if (!input.refundRequestId?.trim()) {
				throw new Error("Mock refund requires refundRequestId for idempotency");
			}
			if (!input.paymentReference?.trim()) {
				throw new Error("Mock refund requires paymentReference");
			}
			return {
				providerRefundId: `mock_refund_${input.refundRequestId}`,
				refundRequestId: input.refundRequestId,
				status: "succeeded",
				amount: input.amount ?? 0,
				currency: input.currency,
			};
		},

		formatAmount(amount: number, currency: string): string {
			return format(money(currency, amount));
		},

		...(options.omitGetPaymentStatus
			? {}
			: {
					async getPaymentStatus(
						_ctx: unknown,
						paymentReference: string,
					): Promise<PaymentStatusResult> {
						if (options.getPaymentStatusResult) {
							return {
								...options.getPaymentStatusResult,
								paymentReference:
									options.getPaymentStatusResult.paymentReference ?? paymentReference,
							};
						}
						return { status: "succeeded", paymentReference };
					},
				}),
	};
}

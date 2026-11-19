/**
 * PaystackPaymentProvider — Paystack implementing @dashcommerce/core's
 * PaymentProvider interface.
 *
 * Channel note: Paystack's hosted checkout page offers whichever
 * channels are enabled on the merchant's Paystack Kenya account
 * ("card", "mobile_money" — M-Pesa STK is triggered from inside the
 * `mobile_money` channel on the hosted page).
 */

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
} from "@dashcommerce/core/payment-provider";
import { call, type PaystackClientOptions } from "./client";
import { verifyPaystackSignature } from "./webhook-verify";

const SUPPORTED_CURRENCIES = new Set(["KES", "NGN", "GHS", "ZAR", "USD"]);

const PAYSTACK_CHANNEL_MAP: Record<string, string> = {
	card: "card",
	mpesa: "mobile_money",
	"m-pesa": "mobile_money",
	mobile_money: "mobile_money",
};

/**
 * Paystack accepts only `-`, `.`, `=` and alphanumerics in a transaction
 * reference. Core's draft ids are hex, so this is normally `dc-<draftId>`;
 * anything else is replaced rather than sent and rejected.
 */
export function paystackReferenceFor(orderDraftId: string): string {
	return `${REFERENCE_PREFIX}${orderDraftId.replace(/[^A-Za-z0-9.=-]/g, "-")}`;
}

const REFERENCE_PREFIX = "dc-";

/** Recover a core draft id from a reference this provider issued. */
function draftIdFromReference(reference: string): string | undefined {
	if (!reference.startsWith(REFERENCE_PREFIX)) return undefined;
	const id = reference.slice(REFERENCE_PREFIX.length);
	return /^[0-9a-f]{32}$/.test(id) ? id : undefined;
}

/**
 * Core builds the success URL for Stripe, with a `{CHECKOUT_SESSION_ID}`
 * placeholder that Stripe fills in. Paystack does not, so drop it and let
 * Paystack append its own `trxref` and `reference` parameters.
 */
function paystackCallbackUrl(successUrl: string): string {
	const url = new URL(successUrl);
	for (const [key, value] of [...url.searchParams]) {
		if (value === "{CHECKOUT_SESSION_ID}") url.searchParams.delete(key);
	}
	return url.toString();
}

/** Paystack documents metadata as a JSON object, but tolerate a string. */
function metadataOf(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

function toPaystackClient(credentials: PaymentProviderCredentials): PaystackClientOptions {
	return { secretKey: credentials.secretKey };
}

function mapChannels(preferred: string[] | undefined): string[] | undefined {
	if (!preferred || preferred.length === 0) return undefined;
	const mapped = new Set<string>();
	for (const p of preferred) {
		const m = PAYSTACK_CHANNEL_MAP[p.toLowerCase()];
		if (m) mapped.add(m);
	}
	return mapped.size > 0 ? Array.from(mapped) : undefined;
}

interface PaystackInitializeData {
	authorization_url: string;
	access_code: string;
	reference: string;
}

interface PaystackWebhookEvent {
	event: string;
	data: {
		id: number;
		reference: string;
		amount?: number;
		currency?: string;
		status?: string;
		customer?: {
			id?: number;
			email?: string;
			first_name?: string;
			last_name?: string;
			phone?: string;
		};
		authorization?: { channel?: string };
		channel?: string;
		metadata?: {
			orderDraftId?: string;
			checkoutReference?: string;
			billingAddress?: unknown;
			shippingAddress?: unknown;
			[key: string]: unknown;
		};
		gateway_response?: string;
	};
}

interface PaystackVerifyData {
	id: number;
	reference: string;
	amount: number;
	currency: string;
	status: string;
	gateway_response?: string;
	channel?: string;
}

interface PaystackRefundData {
	id: number;
	status: string;
	amount: number;
	currency: string;
}

export const paystackPaymentProvider: PaymentProvider = {
	id: "paystack",
	label: "Paystack",
	capabilities: {
		coupons: false,
		connect: false,
		subscriptions: false,
	},

	supportsCurrency(currency: string): boolean {
		if (!currency || typeof currency !== "string") return false;
		return SUPPORTED_CURRENCIES.has(currency.trim().toUpperCase());
	},

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const email = input.customer.email?.trim();
		if (!email) {
			throw new Error("Paystack requires customer email to initialize checkout");
		}
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			throw new Error("Paystack requires a valid customer email to initialize checkout");
		}

		if (!SUPPORTED_CURRENCIES.has(input.currency.trim().toUpperCase())) {
			throw new Error(`Paystack does not support currency ${input.currency}`);
		}
		if (input.mode === "subscription") {
			throw new Error("Paystack provider does not support subscription checkout");
		}

		const client = toPaystackClient(credentials);
		const channels = mapChannels(input.preferredChannels);
		const checkoutRef = paystackReferenceFor(input.orderDraftId);

		const data = await call<PaystackInitializeData>(ctx, {
			client,
			path: "/transaction/initialize",
			body: {
				email,
				amount: input.amount,
				currency: input.currency.toUpperCase(),
				reference: checkoutRef,
				callback_url: paystackCallbackUrl(input.successUrl),
				metadata: {
					...input.metadata,
					orderDraftId: input.orderDraftId,
				},
				...(channels ? { channels } : {}),
			},
		});

		return {
			kind: "redirect",
			redirectUrl: data.authorization_url,
			checkoutReference: data.reference,
		};
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		const result = await verifyPaystackSignature({
			payload: input.rawBody,
			signatureHeader: input.signatureHeader,
			secret: input.secret,
		});
		return { ok: result.ok, reason: result.reason };
	},

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let event: PaystackWebhookEvent;
		try {
			event = JSON.parse(rawBody);
		} catch {
			return {
				type: "unhandled",
				providerEventType: "unparseable",
				raw: rawBody,
			};
		}

		if (!event || typeof event !== "object" || !event.event) {
			return {
				type: "unhandled",
				providerEventType: "malformed",
				raw: event,
			};
		}

		// Paystack documents `charge.success` for completed payments. It has no
		// `charge.failed` webhook, so failures are left to the draft expiring.
		if (event.event === "charge.success") {
			const d = event.data;
			const metaDraftId = metadataOf(d?.metadata)?.orderDraftId;
			const orderDraftId =
				typeof metaDraftId === "string" && metaDraftId
					? metaDraftId
					: draftIdFromReference(d?.reference ?? "");
			if (!orderDraftId || !d.reference || !d.currency || typeof d.amount !== "number") {
				return {
					type: "unhandled",
					providerEventType: event.event,
					raw: event,
				};
			}

			const customerName = [d.customer?.first_name, d.customer?.last_name]
				.filter(Boolean)
				.join(" ");

			const rawChannel = d.channel ?? d.authorization?.channel;
			const displayChannel =
				rawChannel === "mobile_money" ? "M-Pesa" : rawChannel === "card" ? "Card" : rawChannel;

			return {
				type: "charge.succeeded",
				orderDraftId,
				providerId: "paystack",
				// The reference, not the numeric id: core passes paymentReference
				// to getPaymentStatus, and /transaction/verify accepts only the
				// reference. /refund accepts either.
				checkoutReference: d.reference,
				paymentReference: d.reference,
				// Paystack webhooks carry no event id (`data.id` is the transaction).
				// Leaving this empty makes core skip event-level dedup, which it
				// records before the handler runs and never releases: a delivery
				// that failed (say Paystack's verify was briefly down) would turn
				// every retry into a "duplicate" and the paid order would never be
				// created. Core still refuses a second order for the same payment
				// through its unique index on the payment reference.
				providerEventId: "",
				amount: d.amount,
				currency: d.currency.toUpperCase(),
				customer: {
					email: d.customer?.email ?? "",
					...(customerName ? { name: customerName } : {}),
					...(d.customer?.phone ? { phone: d.customer.phone } : {}),
				},
				...(displayChannel ? { channel: displayChannel } : {}),
				raw: event,
			};
		}

		return {
			type: "unhandled",
			providerEventType: event.event,
			raw: event,
		};
	},

	async getPaymentStatus(
		ctx: PaymentProviderRuntimeContext,
		paymentOrCheckoutReference: string,
		credentials: PaymentProviderCredentials,
	): Promise<{
		status: "pending" | "succeeded" | "failed";
		paymentReference?: string;
		amount?: number;
		currency?: string;
		reason?: string;
	}> {
		const client = toPaystackClient(credentials);
		if (!paymentOrCheckoutReference) {
			return {
				status: "failed",
				reason: "No reference provided for payment status lookup",
			};
		}

		const data = await call<PaystackVerifyData>(ctx, {
			client,
			method: "GET",
			path: `/transaction/verify/${encodeURIComponent(paymentOrCheckoutReference)}`,
		});

		let status: "pending" | "succeeded" | "failed";
		if (data.status === "success") {
			status = "succeeded";
		} else if (data.status === "failed") {
			status = "failed";
		} else {
			status = "pending";
		}

		return {
			status,
			paymentReference: data.reference,
			amount: data.amount,
			currency: data.currency?.toUpperCase(),
			reason: data.gateway_response,
		};
	},

	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		if (!input.refundRequestId || !input.refundRequestId.trim()) {
			throw new Error(
				"Paystack refund requires a non-empty refundRequestId for operation idempotency",
			);
		}

		const client = toPaystackClient(credentials);
		const transactionRef = input.paymentReference;
		if (!transactionRef) {
			throw new Error("Paystack refund requires paymentReference");
		}

		const note = input.reason ? `${input.refundRequestId}: ${input.reason}` : input.refundRequestId;

		const data = await call<PaystackRefundData>(ctx, {
			client,
			path: "/refund",
			body: {
				transaction: transactionRef,
				...(input.amount !== undefined ? { amount: input.amount } : {}),
				currency: input.currency.toUpperCase(),
				merchant_note: note,
			},
		});

		const status: RefundResult["status"] =
			data.status === "processed" || data.status === "success"
				? "succeeded"
				: data.status === "failed"
					? "failed"
					: "pending";

		return {
			providerRefundId: String(data.id),
			refundRequestId: input.refundRequestId,
			status,
			amount: data.amount,
			currency: (data.currency ?? input.currency).toUpperCase(),
		};
	},

	formatAmount(amount: number, currency: string): string {
		const major = (amount / 100).toFixed(2);
		return `${currency.toUpperCase()} ${major}`;
	},
};

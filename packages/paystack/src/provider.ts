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
	ConnectionCheckResult,
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
import { CurrencyNotSupportedError } from "@dashcommerce/core/payment-provider";
import { PaystackApiError, type PaystackClientOptions, call, callEnvelope } from "./client";
import { PAYSTACK_LOGO } from "./logo";
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
	merchant_note?: string | null;
	createdAt?: string;
}

interface PaystackRefundPage {
	data: PaystackRefundData[];
	pageCount: number;
}

/**
 * Transaction statuses from https://paystack.com/docs/payments/verify-payments/,
 * plus `reversal-pending`, which the docs omit but /transaction/verify returns
 * once a refund has started (seen on the test account, 19 Nov 2026).
 * A reversed transaction was paid: Paystack reports `reversed` and
 * `reversal-pending` after partial refunds too, and those refunds are tracked
 * on their own. `getPaymentStatus` refuses only one that has been refunded in
 * full, so a late webhook retry cannot create an order for money already
 * returned.
 * `abandoned` is not final: the customer may still complete the payment.
 */
const TRANSACTION_STATUS: Record<string, "pending" | "succeeded" | "failed"> = {
	success: "succeeded",
	reversed: "succeeded",
	"reversal-pending": "succeeded",
	failed: "failed",
	abandoned: "pending",
	ongoing: "pending",
	pending: "pending",
	processing: "pending",
	queued: "pending",
};

/** Refund statuses from https://paystack.com/docs/payments/refunds/. */
const REFUND_STATUS: Record<string, RefundResult["status"]> = {
	pending: "pending",
	processing: "pending",
	"needs-attention": "pending",
	processed: "succeeded",
	failed: "failed",
};

/**
 * Paystack keeps no idempotency key for refunds, and assigns its own refund
 * reference. `merchant_note` is the only field that keeps ours, so the request
 * id goes there in a form that can be read back exactly.
 */
const REFUND_REQUEST_ID = /^[^\s()]+$/;
// Anchored at the end, so text in `reason` cannot pose as the tag.
const NOTE_REQUEST_ID = /\(refundRequestId=([^\s()]+)\)\s*$/;

function merchantNoteFor(refundRequestId: string, reason?: string): string {
	const tag = `(refundRequestId=${refundRequestId})`;
	const text = reason?.replace(/[()]/g, "").trim();
	return text ? `${text} ${tag}` : tag;
}

const REVERSED = new Set(["reversed", "reversal-pending"]);

const REFUND_PAGE_SIZE = 100;
const MAX_REFUND_PAGES = 20;

/**
 * Find a refund on this transaction already made for `refundRequestId`.
 * Refunds are listed by the numeric transaction id: filtering by reference
 * silently returns nothing. A failed refund does not count, so it can be
 * retried. The earliest match wins.
 */
async function findRefundForRequest(
	ctx: PaymentProviderRuntimeContext,
	client: PaystackClientOptions,
	transactionRef: string,
	refundRequestId: string,
): Promise<PaystackRefundData | undefined> {
	const transaction = await call<PaystackVerifyData>(ctx, {
		client,
		method: "GET",
		path: `/transaction/verify/${encodeURIComponent(transactionRef)}`,
	});
	if (!Number.isSafeInteger(transaction.id)) {
		throw new Error("Paystack verify returned no numeric transaction id; refusing to refund blind");
	}

	const matches: PaystackRefundData[] = [];
	for (let page = 1, pageCount = 1; page <= pageCount; page += 1) {
		if (page > MAX_REFUND_PAGES) {
			throw new Error(
				`Paystack lists more than ${MAX_REFUND_PAGES} pages of refunds for one transaction`,
			);
		}
		const result = await listRefundPage(ctx, client, transaction.id, page);
		for (const refund of result.data) {
			const tagged = NOTE_REQUEST_ID.exec(refund.merchant_note ?? "")?.[1];
			if (tagged === refundRequestId && refund.status !== "failed") matches.push(refund);
		}
		pageCount = result.pageCount;
	}

	matches.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id - b.id);
	return matches[0];
}

/** Sum of a transaction's refunds that have not failed, in minor units. */
async function refundedTotal(
	ctx: PaymentProviderRuntimeContext,
	client: PaystackClientOptions,
	transactionId: number,
): Promise<number> {
	let total = 0;
	for (let page = 1, pageCount = 1; page <= pageCount; page += 1) {
		if (page > MAX_REFUND_PAGES) {
			throw new Error(
				`Paystack lists more than ${MAX_REFUND_PAGES} pages of refunds for one transaction`,
			);
		}
		const result = await listRefundPage(ctx, client, transactionId, page);
		for (const refund of result.data) {
			if (refund.status !== "failed" && typeof refund.amount === "number") total += refund.amount;
		}
		pageCount = result.pageCount;
	}
	return total;
}

async function listRefundPage(
	ctx: PaymentProviderRuntimeContext,
	client: PaystackClientOptions,
	transactionId: number,
	page: number,
): Promise<PaystackRefundPage> {
	const query = new URLSearchParams({
		transaction: String(transactionId),
		perPage: String(REFUND_PAGE_SIZE),
		page: String(page),
	});
	const result = await callEnvelope<PaystackRefundData[]>(ctx, {
		client,
		method: "GET",
		path: `/refund?${query}`,
	});
	if (!Array.isArray(result.data)) {
		throw new Error("Paystack refund list returned no data array");
	}
	const pageCount = result.meta?.pageCount;
	return {
		data: result.data,
		pageCount: typeof pageCount === "number" ? pageCount : 1,
	};
}

const SECRET_KEY = /^sk_(test|live)_/;

/**
 * Pick the header and the secret to verify it with. `Paystack-Signature` is
 * keyed with the `whsec_` signing secret; `x-paystack-signature` with the
 * `sk_` secret key, which may be saved as the webhook secret or as the API
 * key. Paystack can send either or both: a real test-mode run delivered only
 * `x-paystack-signature` on an account that had a `whsec_` secret.
 *
 * When `Paystack-Signature` is present and a `whsec_` secret is saved, it
 * decides alone, so a replay outside its 300-second window cannot pass on
 * the window-less legacy header sent alongside it.
 */
function signatureToVerify(input: VerifyWebhookInput): { header: string; secret: string } {
	const current = input.headers?.get("paystack-signature") ?? null;
	const legacy = input.headers?.get("x-paystack-signature") ?? null;
	const saved = [input.secret, input.credentials?.webhookSecret, input.credentials?.secretKey];
	const whsec = saved.find((s) => s?.startsWith("whsec_"));
	const skKey = saved.find((s) => s !== undefined && SECRET_KEY.test(s));

	if (current && whsec) return { header: current, secret: whsec };
	if (legacy && skKey) return { header: legacy, secret: skKey };
	// Nothing pairs up: verify what core routed on with the webhook secret,
	// which gives the merchant the precise reason it fails.
	return { header: input.signatureHeader, secret: input.secret };
}

interface PaystackRefundWebhookData {
	id?: number | string;
	status?: string;
	transaction_reference?: string;
	refund_reference?: string;
}

/** Refund webhooks, from https://paystack.com/docs/payments/refunds/. */
const REFUND_EVENT_STATUS: Record<string, "pending" | "succeeded" | "failed"> = {
	"refund.pending": "pending",
	"refund.processing": "pending",
	"refund.needs-attention": "pending",
	"refund.processed": "succeeded",
	"refund.failed": "failed",
};

/**
 * Report a refund's new status by the numeric refund id that `refund()`
 * returned. Paystack's documented sample shows only `refund_reference`, but
 * real deliveries carry `id` (a string such as "19244346") with a null
 * `refund_reference`. Without an id the event is left unhandled rather than
 * matched by guesswork.
 */
function refundEvent(
	eventName: string,
	data: PaystackRefundWebhookData | undefined,
	raw: unknown,
): NormalizedPaymentEvent {
	const status = REFUND_EVENT_STATUS[eventName];
	const id = data?.id;
	if (!status || (typeof id !== "number" && typeof id !== "string") || String(id) === "") {
		return { type: "unhandled", providerEventType: eventName, raw };
	}
	return {
		type: "refund.updated",
		providerId: "paystack",
		// Paystack sends no event id, so the event name plus the refund id
		// stands in for one. Core records it before the handler runs, so a
		// repeat or overlapping delivery of the same status is skipped instead
		// of reversing a failed refund twice. Each status keeps its own id, so
		// `refund.pending` never blocks the later `refund.failed`.
		providerEventId: `${eventName}:${String(id)}`,
		providerRefundId: String(id),
		status,
		...(data?.transaction_reference ? { paymentReference: data.transaction_reference } : {}),
		raw,
	};
}

export const paystackPaymentProvider: PaymentProvider = {
	id: "paystack",
	label: "Paystack",
	capabilities: {
		coupons: false,
		connect: false,
		subscriptions: false,
	},

	logo: PAYSTACK_LOGO,
	description: "Card and M-Pesa payments for African shoppers, settled in your local currency.",
	// Hosted page, or the Popup over the store's checkout (./checkout-client).
	checkoutStyles: ["hosted", "on_page"],

	// Current scheme first; see ./webhook-verify for both.
	webhookHeaders: ["paystack-signature", "x-paystack-signature"],

	credentialFields: {
		secretKey: {
			label: "Paystack secret or restricted key",
			prefixes: ["sk_test_", "sk_live_", "rk_test_", "rk_live_"],
			help: "Best: a restricted key with transactions:write and disputes_refunds:write only.",
		},
		webhookSecret: {
			label: "Paystack webhook signing secret",
			prefixes: ["whsec_", "sk_test_", "sk_live_"],
			help: "The whsec_ signing secret from Developers → API configuration, or your sk_ secret key. Webhooks Paystack signs with the secret key are checked with the sk_ key from either field.",
		},
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

		const currency = input.currency.trim().toUpperCase();
		if (!SUPPORTED_CURRENCIES.has(currency)) {
			throw new CurrencyNotSupportedError(currency);
		}
		if (input.mode === "subscription") {
			throw new Error("Paystack provider does not support subscription checkout");
		}

		const client = toPaystackClient(credentials);
		const channels = mapChannels(input.preferredChannels);
		const checkoutRef = paystackReferenceFor(input.orderDraftId);

		let data: PaystackInitializeData;
		try {
			data = await call<PaystackInitializeData>(ctx, {
				client,
				path: "/transaction/initialize",
				body: {
					email,
					amount: input.amount,
					currency,
					reference: checkoutRef,
					callback_url: paystackCallbackUrl(input.successUrl),
					metadata: {
						...input.metadata,
						orderDraftId: input.orderDraftId,
					},
					...(channels ? { channels } : {}),
				},
			});
		} catch (err) {
			// An account not enabled for the currency (Paystack answers 403
			// `unsupported_currency`). Core turns this into a clear message.
			if (err instanceof PaystackApiError && err.body.code === "unsupported_currency") {
				throw new CurrencyNotSupportedError(currency);
			}
			throw err;
		}

		if (input.checkoutStyle === "on_page") {
			return {
				kind: "on_page",
				checkoutReference: data.reference,
				client: { accessCode: data.access_code },
			};
		}
		return {
			kind: "redirect",
			redirectUrl: data.authorization_url,
			checkoutReference: data.reference,
		};
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		const { header, secret } = signatureToVerify(input);
		const result = await verifyPaystackSignature({
			payload: input.rawBody,
			signatureHeader: header,
			secret,
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

		if (event.event.startsWith("refund.")) {
			return refundEvent(event.event, event.data as unknown as PaystackRefundWebhookData, event);
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
				// Paystack webhooks carry no event id (`data.id` is the transaction),
				// so the reference stands in for one. Core records it before the
				// handler runs, so two overlapping deliveries never both run it.
				// When confirming with Paystack fails, core releases the record, so
				// Paystack's retry still creates the order. Other failures keep it,
				// as they do for Stripe.
				providerEventId: `charge.success:${d.reference}`,
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

	/**
	 * Verifies a reference that can't exist. Paystack answers
	 * `transaction_not_found` only for a key it accepts that can read
	 * transactions, which checkout needs; nothing is created.
	 */
	async checkConnection(
		ctx: PaymentProviderRuntimeContext,
		credentials: PaymentProviderCredentials,
	): Promise<ConnectionCheckResult> {
		const mode: ConnectionCheckResult["mode"] = /^(sk|rk)_live_/.test(credentials.secretKey)
			? "live"
			: /^(sk|rk)_test_/.test(credentials.secretKey)
				? "test"
				: undefined;
		const modeResult = mode ? { mode } : {};
		try {
			await call(ctx, {
				client: toPaystackClient(credentials),
				method: "GET",
				path: "/transaction/verify/dashcommerce-connection-check",
			});
		} catch (err) {
			if (!(err instanceof PaystackApiError)) throw err;
			if (err.body.code === "transaction_not_found") {
				return {
					ok: true,
					...modeResult,
					message: `Connected${mode ? ` in ${mode} mode` : ""}. The key can read transactions.`,
				};
			}
			if (err.status === 401 || err.status === 403) {
				return { ok: false, ...modeResult, message: `Paystack refused the key: ${err.message}` };
			}
			return {
				ok: false,
				...modeResult,
				message: `Paystack answered ${err.status}: ${err.message}`,
			};
		}
		return { ok: true, ...modeResult, message: `Connected${mode ? ` in ${mode} mode` : ""}.` };
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

		const status = TRANSACTION_STATUS[data.status];
		if (REVERSED.has(data.status) && Number.isSafeInteger(data.id)) {
			const refunded = await refundedTotal(ctx, client, data.id);
			if (refunded >= data.amount) {
				return {
					status: "failed",
					paymentReference: data.reference,
					amount: data.amount,
					currency: data.currency?.toUpperCase(),
					reason: `Payment was refunded in full at Paystack (${refunded} of ${data.amount})`,
				};
			}
		}
		return {
			status: status ?? "pending",
			paymentReference: data.reference,
			amount: data.amount,
			currency: data.currency?.toUpperCase(),
			reason: status ? data.gateway_response : `Unrecognised Paystack status: ${data.status}`,
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

		if (!REFUND_REQUEST_ID.test(input.refundRequestId)) {
			throw new Error(
				"Paystack refund needs a refundRequestId without spaces or brackets, so the merchant note can carry it",
			);
		}

		const client = toPaystackClient(credentials);
		const transactionRef = input.paymentReference;
		if (!transactionRef) {
			throw new Error("Paystack refund requires paymentReference");
		}

		// Paystack accepts an identical second refund as a new one (tested on
		// 19 Nov 2026), so a retry with the same refundRequestId must find the
		// first refund rather than create another.
		const existing = await findRefundForRequest(ctx, client, transactionRef, input.refundRequestId);
		const data =
			existing ??
			(await call<PaystackRefundData>(ctx, {
				client,
				path: "/refund",
				body: {
					transaction: transactionRef,
					...(input.amount !== undefined ? { amount: input.amount } : {}),
					currency: input.currency.toUpperCase(),
					merchant_note: merchantNoteFor(input.refundRequestId, input.reason),
				},
			}));

		return {
			providerRefundId: String(data.id),
			refundRequestId: input.refundRequestId,
			status: REFUND_STATUS[data.status] ?? "pending",
			amount: data.amount,
			currency: (data.currency ?? input.currency).toUpperCase(),
		};
	},

	formatAmount(amount: number, currency: string): string {
		const major = (amount / 100).toFixed(2);
		return `${currency.toUpperCase()} ${major}`;
	},
};

/**
 * FlutterwavePaymentProvider — Flutterwave implementing @dashcommerce/core's
 * PaymentProvider interface.
 *
 * Amounts: core works in integer minor units; Flutterwave's v3 API works in
 * major units (100 NGN is `100`, not `10000`). This adapter converts at the
 * boundary and nowhere else.
 *
 * Checkout is Flutterwave's hosted page. Flutterwave Inline, the on-page
 * option, needs the account's public key, which core's provider settings do
 * not store; the hosted page is the equivalent flow today.
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
import {
	FlutterwaveApiError,
	type FlutterwaveCallOptions,
	type FlutterwaveResponse,
	call,
	callEnvelope,
} from "./client";
import { verifyFlutterwaveSecretHash } from "./webhook-verify";

const SUPPORTED_CURRENCIES = new Set([
	"NGN",
	"USD",
	"GBP",
	"EUR",
	"KES",
	"GHS",
	"ZAR",
	"UGX",
	"TZS",
	"RWF",
	"XOF",
	"XAF",
	"ZMW",
	"MWK",
	"EGP",
]);

const REFERENCE_PREFIX = "dc-";

/**
 * Flutterwave requires a unique `tx_ref` per transaction. Core's draft ids are
 * hex, so this is normally `dc-<draftId>`; anything else is replaced rather
 * than sent and rejected.
 */
export function flutterwaveReferenceFor(orderDraftId: string): string {
	return `${REFERENCE_PREFIX}${orderDraftId.replace(/[^A-Za-z0-9.=-]/g, "-")}`;
}

/** Recover a core draft id from a reference this provider issued. */
function draftIdFromReference(reference: string): string | undefined {
	if (!reference.startsWith(REFERENCE_PREFIX)) return undefined;
	const id = reference.slice(REFERENCE_PREFIX.length);
	return /^[0-9a-f]{32}$/.test(id) ? id : undefined;
}

/**
 * Core builds the success URL for Stripe, with a `{CHECKOUT_SESSION_ID}`
 * placeholder that Stripe fills in. Flutterwave appends `status`, `tx_ref`
 * and `transaction_id`, so drop the placeholder.
 */
function flutterwaveCallbackUrl(successUrl: string): string {
	const url = new URL(successUrl);
	for (const [key, value] of [...url.searchParams]) {
		if (value === "{CHECKOUT_SESSION_ID}") url.searchParams.delete(key);
	}
	return url.toString();
}

/** Flutterwave documents `meta` as an object, but some deliveries carry a string. */
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

/** Core minor units → Flutterwave major units, e.g. 250000 → 2500. */
export function toMajorUnits(amount: number): number {
	if (!Number.isSafeInteger(amount) || amount < 0) {
		throw new Error("Flutterwave amount must be a non-negative integer in minor units");
	}
	return Number((amount / 100).toFixed(2));
}

/** Flutterwave major units → core minor units, e.g. 2500 → 250000. */
export function toMinorUnits(amount: unknown): number | undefined {
	const value = typeof amount === "string" ? Number(amount) : amount;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.round(value * 100);
}

function toFlutterwaveClient(credentials: PaymentProviderCredentials) {
	return { secretKey: credentials.secretKey };
}

/**
 * Flutterwave's mobile-money option differs by country, and `mpesa` is only
 * valid for KES. A generic `mobile_money` hint is resolved with the cart's
 * currency so the right option reaches the hosted page.
 */
const MOBILE_MONEY_BY_CURRENCY: Record<string, string> = {
	KES: "mpesa",
	GHS: "mobilemoneyghana",
	UGX: "mobilemoneyuganda",
	RWF: "mobilemoneyrwanda",
	TZS: "mobilemoneytanzania",
	ZMW: "mobilemoneyzambia",
	MWK: "mobilemoneymalawi",
	XOF: "mobilemoneyxof",
	XAF: "mobilemoneyxaf",
};

function mapChannel(channel: string, currency: string): string | undefined {
	switch (channel.toLowerCase()) {
		case "card":
			return "card";
		case "mpesa":
		case "m-pesa":
			return "mpesa";
		case "mobile_money":
		case "mobilemoney":
			return MOBILE_MONEY_BY_CURRENCY[currency] ?? "mpesa";
		case "bank_transfer":
		case "banktransfer":
			return "banktransfer";
		case "ussd":
			return "ussd";
		case "account":
			return "account";
		case "opay":
			return "opay";
		default:
			return undefined;
	}
}

function mapPaymentOptions(
	preferred: string[] | undefined,
	currency: string,
): string[] | undefined {
	if (!preferred || preferred.length === 0) return undefined;
	const mapped = new Set<string>();
	for (const channel of preferred) {
		const option = mapChannel(channel, currency);
		if (option) mapped.add(option);
	}
	return mapped.size > 0 ? Array.from(mapped) : undefined;
}

interface FlutterwaveSubaccount {
	id: string;
	transaction_charge_type: "flat_subaccount";
	transaction_charge: number;
}

/**
 * Flutterwave's `flat_subaccount` charge pays a subaccount an exact amount;
 * core's allocations are already exact minor-unit shares, so they map one to
 * one. Validate before sending: a bad share must fail checkout rather than
 * settle the whole payment to the platform.
 */
function subaccountsFor(input: InitCheckoutInput): FlutterwaveSubaccount[] | undefined {
	if (!input.allocations || input.allocations.length === 0) return undefined;
	let total = 0;
	const subaccounts = input.allocations.map((allocation) => {
		const reference = allocation.accountReference?.trim();
		if (!reference) {
			throw new Error(`Vendor ${allocation.vendorId} has no Flutterwave subaccount id`);
		}
		if (!Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor <= 0) {
			throw new Error(
				`Vendor ${allocation.vendorId}'s split amount must be a positive integer in minor units`,
			);
		}
		total += allocation.amountMinor;
		if (!Number.isSafeInteger(total)) {
			throw new Error("Split allocations exceed the safe integer range");
		}
		return {
			id: reference,
			transaction_charge_type: "flat_subaccount" as const,
			transaction_charge: toMajorUnits(allocation.amountMinor),
		};
	});
	if (total > input.amount) {
		throw new Error(`Split allocations (${total}) exceed the checkout amount (${input.amount})`);
	}
	if (input.platformRemainderMinor !== undefined && input.platformRemainderMinor < 0) {
		throw new Error("Platform remainder cannot be negative");
	}
	return subaccounts;
}

function channelLabel(type: string | undefined): string | undefined {
	if (!type) return undefined;
	const value = type.toLowerCase();
	if (value === "card") return "Card";
	if (value === "mpesa") return "M-Pesa";
	if (value === "banktransfer" || value === "bank_transfer") return "Bank transfer";
	if (value === "ussd") return "USSD";
	if (value === "account") return "Bank account";
	if (value.startsWith("mobilemoney") || value === "mobile_money") return "Mobile money";
	return type;
}

interface FlutterwaveCustomer {
	id?: number;
	name?: string | null;
	phone_number?: string | null;
	email?: string;
}

interface FlutterwaveChargeData {
	id: number | string;
	tx_ref?: string;
	flw_ref?: string;
	amount?: number | string;
	currency?: string;
	charged_amount?: number | string;
	status?: string;
	payment_type?: string;
	processor_response?: string;
	customer?: FlutterwaveCustomer;
	meta?: unknown;
}

interface FlutterwaveWebhookEvent {
	event: string;
	data: FlutterwaveChargeData;
	"event.type"?: string;
}

interface FlutterwaveVerifyData extends FlutterwaveChargeData {
	amount_settled?: number | string;
}

interface FlutterwaveRefundData {
	id: number;
	amount_refunded?: number | string;
	status?: string;
	comment?: string | null;
	comments?: string | null;
	flw_ref?: string;
	meta?: unknown;
	created_at?: string;
	createdAt?: string;
	transaction_id?: number;
	TransactionId?: number;
}

/**
 * Transaction statuses from
 * https://developer.flutterwave.com/docs/transaction-verification.
 * `successful` is paid; `failed` and `cancelled` are final failures;
 * `pending` is not final, the customer may still complete it.
 */
const TRANSACTION_STATUS: Record<string, "pending" | "succeeded" | "failed"> = {
	successful: "succeeded",
	success: "succeeded",
	failed: "failed",
	cancelled: "failed",
	canceled: "failed",
	pending: "pending",
	processing: "pending",
};

/**
 * Refund statuses from
 * https://developer.flutterwave.com/docs/payment-operations/refunds.
 * Every `completed*` value is a completed refund; `pending-*` and
 * `processing` are still on their way.
 */
function refundStatus(raw: string | undefined): RefundResult["status"] {
	const value = raw?.toLowerCase() ?? "";
	if (value.startsWith("completed")) return "succeeded";
	if (value === "failed" || value === "declined" || value === "cancelled") return "failed";
	return "pending";
}

function isFailedRefund(raw: string | undefined): boolean {
	return refundStatus(raw) === "failed";
}

/**
 * Flutterwave reports `completed` as soon as it accepts a refund, while the
 * payout to the customer is a separate step tracked in `meta.disburse_status`
 * (a string in some deliveries, an object in others). A `failed` value does
 * not change the refund's status, but it means the customer has not been paid
 * yet, so it is worth a log line.
 */
function disburseStatusOf(meta: unknown): string | undefined {
	const value = metadataOf(meta)?.disburse_status;
	return typeof value === "string" ? value : undefined;
}

/**
 * Flutterwave keeps no idempotency key for refunds. `comments` is the only
 * field that keeps ours, so the request id goes there in a form that can be
 * read back exactly.
 */
const REFUND_REQUEST_ID = /^[^\s()]+$/;
// Anchored at the end, so text in the reason cannot pose as the tag.
const COMMENT_REQUEST_ID = /\(refundRequestId=([^\s()]+)\)\s*$/;

function refundCommentFor(refundRequestId: string, reason?: string): string {
	const tag = `(refundRequestId=${refundRequestId})`;
	const text = reason?.replace(/[()]/g, "").trim();
	return text ? `${text} ${tag}` : tag;
}

const MAX_REFUND_PAGES = 20;

async function listRefundPage(
	ctx: PaymentProviderRuntimeContext,
	client: FlutterwaveCallOptions["client"],
	page: number,
): Promise<{ data: FlutterwaveRefundData[]; totalPages: number }> {
	const result: FlutterwaveResponse<FlutterwaveRefundData[]> = await callEnvelope(ctx, {
		client,
		method: "GET",
		path: `/refunds?page=${page}`,
	});
	if (!Array.isArray(result.data)) {
		throw new Error("Flutterwave refund list returned no data array");
	}
	const totalPages = result.meta?.page_info?.total_pages;
	return {
		data: result.data,
		totalPages: typeof totalPages === "number" ? totalPages : 1,
	};
}

function refundTransactionId(refund: FlutterwaveRefundData): number | undefined {
	const id = refund.transaction_id ?? refund.TransactionId;
	return typeof id === "number" ? id : undefined;
}

/**
 * Find a refund on this transaction already made for `refundRequestId`.
 * Flutterwave's refund list is not filterable by transaction, so this walks
 * recent pages and matches the id and the tag. A failed refund does not
 * count, so it can be retried. The earliest match wins.
 *
 * `GET /v3/refunds` is not available to every key: a real test-mode run
 * (24 Nov 2026) answered `400 {"message":"unauthorized"}` on an account that
 * could create refunds and verify payments. That is an account/permission
 * limit, not a transient failure, so refunds continue without the duplicate
 * check and say so in the log. Any other failure still throws: a refund that
 * cannot be de-duplicated because the network is down is better retried than
 * guessed at.
 */
async function findRefundForRequest(
	ctx: PaymentProviderRuntimeContext,
	client: FlutterwaveCallOptions["client"],
	transactionId: number,
	refundRequestId: string,
): Promise<FlutterwaveRefundData | undefined> {
	const matches: FlutterwaveRefundData[] = [];
	try {
		for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
			if (page > MAX_REFUND_PAGES) {
				// Refunds are rare and the newest ones are listed first, so the
				// retry that matters is almost always in range. Say so rather than
				// blocking every refund on a store with a long refund history.
				ctx.log.warn("Flutterwave refund list exceeded the lookup window", {
					pagesScanned: MAX_REFUND_PAGES,
					refundRequestId,
				});
				break;
			}
			const result = await listRefundPage(ctx, client, page);
			for (const refund of result.data) {
				if (refundTransactionId(refund) !== transactionId) continue;
				const note = refund.comment ?? refund.comments ?? "";
				if (COMMENT_REQUEST_ID.exec(note)?.[1] !== refundRequestId) continue;
				if (!isFailedRefund(refund.status)) matches.push(refund);
			}
			totalPages = result.totalPages;
		}
	} catch (err) {
		const unavailable =
			err instanceof FlutterwaveApiError &&
			(err.status === 401 || err.status === 403 || /unauthori[sz]ed|not found/i.test(err.message));
		if (!unavailable) throw err;
		ctx.log.warn(
			"Flutterwave refund history is not available to this key; a retried refund cannot be de-duplicated",
			{
				refundRequestId,
				reason: err.message,
			},
		);
		return undefined;
	}

	matches.sort(
		(a, b) =>
			(a.created_at ?? a.createdAt ?? "").localeCompare(b.created_at ?? b.createdAt ?? "") ||
			a.id - b.id,
	);
	return matches[0];
}

/** Resolve a transaction id from either a numeric id or a `tx_ref`. */
async function resolveTransactionId(
	ctx: PaymentProviderRuntimeContext,
	client: FlutterwaveCallOptions["client"],
	reference: string,
): Promise<number> {
	if (/^\d+$/.test(reference)) {
		const id = Number(reference);
		if (Number.isSafeInteger(id)) return id;
	}
	const data = await call<FlutterwaveVerifyData>(ctx, {
		client,
		method: "GET",
		path: `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
	});
	const id = Number(data.id);
	if (!Number.isSafeInteger(id) || id <= 0) {
		throw new Error(
			"Flutterwave verify returned no numeric transaction id; refusing to refund blind",
		);
	}
	return id;
}

/**
 * A refund webhook has no `event` field: Flutterwave posts the refund object
 * itself, with capitalised `AmountRefunded`, `FlwRef` and `TransactionId`.
 */
function isRefundWebhook(payload: Record<string, unknown>): boolean {
	if (typeof payload.event === "string") return false;
	const hasAmount = "AmountRefunded" in payload || "amount_refunded" in payload;
	const id = payload.id;
	return (
		(typeof id === "number" || typeof id === "string") &&
		id !== "" &&
		typeof payload.status === "string" &&
		hasAmount
	);
}

function refundEvent(payload: Record<string, unknown>): NormalizedPaymentEvent {
	const rawId = payload.id;
	const id =
		typeof rawId === "number" || (typeof rawId === "string" && rawId !== "")
			? String(rawId)
			: undefined;
	const status = refundStatus(typeof payload.status === "string" ? payload.status : undefined);
	if (!id) {
		return { type: "unhandled", providerEventType: "refund", raw: payload };
	}
	return {
		type: "refund.updated",
		providerId: "flutterwave",
		// Flutterwave sends no event id, so the refund id plus its status
		// stands in for one. Core records it before the handler runs, so a
		// repeat of the same status is skipped instead of reversing a failed
		// refund twice. Each status keeps its own id, so `pending` never
		// blocks the later `completed`.
		providerEventId: `refund:${id}:${status}`,
		providerRefundId: id,
		status,
		raw: payload,
	};
}

export const flutterwavePaymentProvider: PaymentProvider = {
	id: "flutterwave",
	label: "Flutterwave",
	capabilities: {
		coupons: false,
		connect: false,
		subscriptions: false,
		splits: true,
	},

	brandColour: "#f5a623",
	description: "Card, M-Pesa and mobile money across Africa, settled in your local currency.",
	// Hosted page, or Flutterwave Inline over the store's checkout
	// (./checkout-client), which needs the account's public key.
	checkoutStyles: ["hosted", "on_page"],

	webhookHeaders: ["verif-hash"],

	credentialFields: {
		secretKey: {
			label: "Flutterwave secret key",
			prefixes: ["FLWSECK_TEST-", "FLWSECK-"],
			help: "Settings → API Keys. Test keys start FLWSECK_TEST-; live keys start FLWSECK-.",
		},
		webhookSecret: {
			label: "Flutterwave secret hash",
			prefixes: [],
			help: "The secret hash you set under Settings → Webhooks. Flutterwave sends it back in the verif-hash header on every delivery.",
		},
		publicKey: {
			label: "Flutterwave public key",
			prefixes: ["FLWPUBK_TEST-", "FLWPUBK-"],
			help: "Settings → API Keys. Only needed for on-page checkout (Flutterwave Inline); it is safe to expose to the browser.",
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
			throw new Error("Flutterwave requires customer email to initialize checkout");
		}
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			throw new Error("Flutterwave requires a valid customer email to initialize checkout");
		}

		const currency = input.currency.trim().toUpperCase();
		if (!SUPPORTED_CURRENCIES.has(currency)) {
			throw new Error(`Flutterwave does not support currency ${input.currency}`);
		}
		if (input.mode === "subscription") {
			throw new Error("Flutterwave provider does not support subscription checkout");
		}

		const client = toFlutterwaveClient(credentials);
		const checkoutRef = flutterwaveReferenceFor(input.orderDraftId);
		const address = input.shippingAddress ?? input.billingAddress;
		const addressName = [address?.firstName, address?.lastName].filter(Boolean).join(" ");
		const name = input.customer.name ?? (addressName || undefined);
		const phone = input.customer.phone ?? address?.phone;
		const paymentOptions = mapPaymentOptions(input.preferredChannels, currency);
		const subaccounts = subaccountsFor(input);

		if (input.checkoutStyle === "on_page") {
			const publicKey = credentials.publicKey?.trim();
			if (!publicKey) {
				throw new Error(
					"Flutterwave on-page checkout needs the public key; add it in Settings → Payment provider",
				);
			}
			// Inline creates the transaction in the browser, so there is no
			// server-side /payments call. The order still comes only from the
			// signed webhook and the live verify.
			return {
				kind: "on_page",
				checkoutReference: checkoutRef,
				client: {
					publicKey,
					txRef: checkoutRef,
					amount: String(toMajorUnits(input.amount)),
					currency,
					customerEmail: email,
					...(name ? { customerName: name } : {}),
					...(phone ? { customerPhone: phone } : {}),
					...(paymentOptions ? { paymentOptions: paymentOptions.join(",") } : {}),
					...(subaccounts ? { subaccounts: JSON.stringify(subaccounts) } : {}),
					orderDraftId: input.orderDraftId,
				},
			};
		}

		const data = await call<{ link?: string }>(ctx, {
			client,
			path: "/payments",
			body: {
				tx_ref: checkoutRef,
				amount: toMajorUnits(input.amount),
				currency,
				redirect_url: flutterwaveCallbackUrl(input.successUrl),
				customer: {
					email,
					...(name ? { name } : {}),
					...(phone ? { phonenumber: phone } : {}),
				},
				meta: {
					...input.metadata,
					orderDraftId: input.orderDraftId,
				},
				...(paymentOptions ? { payment_options: paymentOptions.join(",") } : {}),
				...(subaccounts ? { subaccounts } : {}),
			},
		});

		if (!data?.link) {
			throw new Error("Flutterwave did not return a hosted checkout link");
		}
		return {
			kind: "redirect",
			redirectUrl: data.link,
			checkoutReference: checkoutRef,
		};
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		return verifyFlutterwaveSecretHash({
			signatureHeader: input.signatureHeader,
			secret: input.secret,
		});
	},

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			return {
				type: "unhandled",
				providerEventType: "unparseable",
				raw: rawBody,
			};
		}

		if (!payload || typeof payload !== "object") {
			return {
				type: "unhandled",
				providerEventType: "malformed",
				raw: payload,
			};
		}

		const record = payload as Record<string, unknown>;
		if (isRefundWebhook(record)) {
			return refundEvent(record);
		}

		const event = payload as FlutterwaveWebhookEvent;
		if (typeof event.event !== "string") {
			return {
				type: "unhandled",
				providerEventType: "malformed",
				raw: payload,
			};
		}

		// The documented refund webhook is a bare refund object (handled
		// above), but accept an event wrapper if Flutterwave adds one.
		if (event.event.startsWith("refund.")) {
			return refundEvent((event.data ?? {}) as unknown as Record<string, unknown>);
		}

		// Flutterwave sends `charge.completed` for both outcomes; `data.status`
		// decides which. There is no separate refund event name.
		if (event.event !== "charge.completed") {
			return {
				type: "unhandled",
				providerEventType: event.event,
				raw: payload,
			};
		}

		const d = event.data;
		const status = d?.status?.toLowerCase();
		const transactionId = d?.id === undefined ? undefined : String(d.id);
		const metaDraftId = metadataOf(d?.meta)?.orderDraftId;
		const orderDraftId =
			typeof metaDraftId === "string" && metaDraftId
				? metaDraftId
				: draftIdFromReference(d?.tx_ref ?? "");

		if (!transactionId || !orderDraftId || !d.tx_ref) {
			return {
				type: "unhandled",
				providerEventType: event.event,
				raw: payload,
			};
		}

		if (status === "failed" || status === "cancelled" || status === "canceled") {
			return {
				type: "charge.failed",
				orderDraftId,
				providerId: "flutterwave",
				providerEventId: `charge.completed:${transactionId}:failed`,
				checkoutReference: d.tx_ref,
				paymentReference: transactionId,
				...(d.processor_response ? { reason: d.processor_response } : {}),
				raw: payload,
			};
		}

		if (status !== "successful" && status !== "success") {
			return {
				type: "unhandled",
				providerEventType: event.event,
				raw: payload,
			};
		}

		const amount = toMinorUnits(d.amount);
		const currency = d.currency?.toUpperCase();
		if (amount === undefined || !currency) {
			return {
				type: "unhandled",
				providerEventType: event.event,
				raw: payload,
			};
		}

		const channel = channelLabel(d.payment_type);
		return {
			type: "charge.succeeded",
			orderDraftId,
			providerId: "flutterwave",
			// The numeric transaction id, not the reference: refunds are made
			// against /transactions/:id/refund.
			paymentReference: transactionId,
			checkoutReference: d.tx_ref,
			// Flutterwave webhooks carry no event id (`data.id` is the
			// transaction), so the id plus status stands in for one. Core
			// records it before the handler runs, so two overlapping deliveries
			// never both run it. When confirming with Flutterwave fails, core
			// releases the record, so Flutterwave's retry still creates the order.
			providerEventId: `charge.completed:${transactionId}:successful`,
			amount,
			currency,
			customer: {
				email: d.customer?.email ?? "",
				...(d.customer?.name ? { name: d.customer.name } : {}),
				...(d.customer?.phone_number ? { phone: d.customer.phone_number } : {}),
			},
			...(channel ? { channel } : {}),
			raw: payload,
		};
	},

	async checkConnection(
		ctx: PaymentProviderRuntimeContext,
		credentials: PaymentProviderCredentials,
	): Promise<ConnectionCheckResult> {
		const mode: ConnectionCheckResult["mode"] = /^FLWSECK_TEST-/i.test(credentials.secretKey)
			? "test"
			: /^FLWSECK-/i.test(credentials.secretKey)
				? "live"
				: undefined;
		const modeResult = mode ? { mode } : {};
		try {
			await call(ctx, {
				client: toFlutterwaveClient(credentials),
				method: "GET",
				path: "/balances",
			});
		} catch (err) {
			if (!(err instanceof FlutterwaveApiError)) throw err;
			if (err.status === 401 || err.status === 403) {
				return { ok: false, ...modeResult, message: `Flutterwave refused the key: ${err.message}` };
			}
			return {
				ok: false,
				...modeResult,
				message: `Flutterwave answered ${err.status}: ${err.message}`,
			};
		}
		return {
			ok: true,
			...modeResult,
			message: `Connected${mode ? ` in ${mode} mode` : ""}. The key can read account balances.`,
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
		const client = toFlutterwaveClient(credentials);
		const reference = paymentOrCheckoutReference?.trim();
		if (!reference) {
			return {
				status: "failed",
				reason: "No reference provided for payment status lookup",
			};
		}

		const path = /^\d+$/.test(reference)
			? `/transactions/${encodeURIComponent(reference)}/verify`
			: `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`;
		const data = await call<FlutterwaveVerifyData>(ctx, { client, method: "GET", path });

		const rawStatus = data.status?.toLowerCase() ?? "";
		const status = TRANSACTION_STATUS[rawStatus];
		const amount = toMinorUnits(data.amount);
		const id = data.id === undefined ? undefined : String(data.id);
		return {
			status: status ?? "pending",
			...(id ? { paymentReference: id } : {}),
			...(amount !== undefined ? { amount } : {}),
			...(data.currency ? { currency: data.currency.toUpperCase() } : {}),
			reason: status
				? data.processor_response
				: `Unrecognised Flutterwave status: ${data.status ?? "(missing)"}`,
		};
	},

	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		if (!input.refundRequestId || !input.refundRequestId.trim()) {
			throw new Error(
				"Flutterwave refund requires a non-empty refundRequestId for operation idempotency",
			);
		}

		if (!REFUND_REQUEST_ID.test(input.refundRequestId)) {
			throw new Error(
				"Flutterwave refund needs a refundRequestId without spaces or brackets, so the refund comment can carry it",
			);
		}

		const client = toFlutterwaveClient(credentials);
		if (!input.paymentReference) {
			throw new Error("Flutterwave refund requires paymentReference");
		}

		const transactionId = await resolveTransactionId(ctx, client, input.paymentReference);

		// Flutterwave accepts an identical second refund as a new one, so a
		// retry with the same refundRequestId must find the first refund
		// rather than create another.
		const existing = await findRefundForRequest(ctx, client, transactionId, input.refundRequestId);
		const data =
			existing ??
			(await call<FlutterwaveRefundData>(ctx, {
				client,
				path: `/transactions/${transactionId}/refund`,
				body: {
					...(input.amount !== undefined ? { amount: toMajorUnits(input.amount) } : {}),
					comments: refundCommentFor(input.refundRequestId, input.reason),
				},
			}));

		const amount = toMinorUnits(data.amount_refunded) ?? input.amount ?? 0;
		if (disburseStatusOf(data.meta) === "failed") {
			ctx.log.warn(
				"Flutterwave accepted the refund but its disbursement failed; the customer has not been paid yet",
				{
					providerRefundId: String(data.id),
					refundRequestId: input.refundRequestId,
				},
			);
		}
		return {
			providerRefundId: String(data.id),
			refundRequestId: input.refundRequestId,
			status: refundStatus(data.status),
			amount,
			currency: input.currency.toUpperCase(),
		};
	},

	formatAmount(amount: number, currency: string): string {
		const major = (amount / 100).toFixed(2);
		return `${currency.toUpperCase()} ${major}`;
	},
};

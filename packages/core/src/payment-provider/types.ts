/**
 * PaymentProvider — the gateway abstraction this fork introduces.
 *
 * Upstream `emdashCommerce/dashcommerce` wires Stripe directly throughout
 * `routes/checkout.ts` and `routes/webhook.ts` (see the module comments
 * there) with no seam for a second gateway. This interface is that seam.
 *
 * Scope, deliberately: this interface covers the payment path every
 * merchant needs regardless of gateway — initialise a charge (embedded or
 * hosted), verify a webhook, mark a charge/session paid, refund. It does
 * NOT attempt to abstract Stripe Connect (multi-vendor payouts) or Stripe
 * Subscriptions/Billing (recurring invoices, dunning) — those are
 * Stripe-specific product surfaces with no structural equivalent in
 * Paystack (Paystack has "subaccounts" and its own recurring-charge
 * primitive, but they are not a drop-in replacement, and Nondies RFC's
 * memberships are annual one-off purchases with no auto-renew per
 * SPEC.md §4.2/§7, so this fork does not need a Paystack subscription
 * implementation to ship). A future contributor wanting Connect-equivalent
 * marketplace payouts or Paystack recurring billing can extend this
 * interface without breaking existing implementations — every method here
 * is optional-safe to add to, none removed.
 *
 * Both `StripePaymentProvider` (this fork, refactored from upstream's
 * direct Stripe calls) and `PaystackPaymentProvider` (in the sibling
 * a gateway package (e.g. Paystack) package) implement this same interface.
 * `routes/checkout.ts` and `routes/webhook.ts` are refactored to depend on
 * `PaymentProvider` only, selected at runtime by `settings:paymentProvider`
 * ("stripe" | "paystack").
 */

/** Integer minor units (cents, kobo) — never a float. */
export interface Money {
	amount: number;
	currency: string; // ISO-4217, e.g. "KES", "USD"
}

export interface PaymentProviderCustomer {
	email: string;
	name?: string;
	phone?: string;
}

export interface PaymentProviderAddress {
	line1?: string;
	line2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	country?: string; // ISO-3166 alpha-2
}

/** One line item for a hosted checkout page. */
export interface PaymentProviderLineItem {
	name: string;
	description?: string;
	amount: number; // minor units
	currency: string;
	quantity: number;
	metadata?: Record<string, string>;
}

export interface InitCheckoutInput {
	/** Our own order-draft id — always echoed back in metadata/reference so
	 * the webhook can correlate the provider's event to our cart snapshot. */
	orderDraftId: string;
	amount: number; // minor units, total charge
	currency: string; // ISO-4217
	customer: PaymentProviderCustomer;
	lineItems: PaymentProviderLineItem[];
	successUrl: string;
	cancelUrl: string;
	metadata?: Record<string, string>;
	/** Channel hint for gateways that support payment-method restriction on
	 * the hosted page (Paystack: card/mobile_money/bank; ignored by Stripe). */
	preferredChannels?: string[];
}

export interface InitCheckoutResult {
	/** Provider's own reference/session/transaction id. */
	providerReference: string;
	/** URL to redirect the customer to for hosted payment. */
	redirectUrl: string;
}

export interface VerifyWebhookInput {
	/** Raw request body — signature verification must run against the
	 * exact bytes received, never a re-serialised parse. */
	rawBody: string;
	/** Provider-specific signature header value(s), passed through
	 * verbatim (e.g. `Stripe-Signature`, `x-paystack-signature`). */
	signatureHeader: string;
	/** Provider secret used for the HMAC (webhook secret, not the API
	 * secret key, when the provider distinguishes the two). */
	secret: string;
}

export interface VerifyWebhookResult {
	ok: boolean;
	reason?: string;
}

/** Normalised webhook event, after provider-specific verification and
 * parsing — this is what `routes/webhook.ts` dispatches on, so it never
 * needs to know which gateway sent it. */
export type NormalizedPaymentEvent =
	| {
			type: "charge.succeeded";
			orderDraftId: string;
			providerReference: string;
			amount: number;
			currency: string;
			customer: PaymentProviderCustomer;
			shippingAddress?: PaymentProviderAddress;
			billingAddress?: PaymentProviderAddress;
			/** Free-text label for how the customer paid — surfaced on the
			 * order (e.g. "M-Pesa", "Card", "Apple Pay"). */
			channel?: string;
			raw: unknown;
	  }
	| {
			type: "charge.failed";
			orderDraftId: string;
			providerReference: string;
			reason?: string;
			raw: unknown;
	  }
	| {
			type: "unhandled";
			providerEventType: string;
			raw: unknown;
	  };

export interface CreateRefundInput {
	/** Provider reference from the original successful charge. */
	providerReference: string;
	/** Minor units. Omit for a full refund. */
	amount?: number;
	currency: string;
	reason?: string;
}

export interface RefundResult {
	providerRefundId: string;
	status: "pending" | "succeeded" | "failed";
	amount: number;
	currency: string;
}

/** Provider-agnostic client credentials — each implementation defines its
 * own concrete shape but every one is loaded the same way: read from
 * plugin KV under `settings:<provider>SecretKey` / `settings:<provider>WebhookSecret`. */
export interface PaymentProviderCredentials {
	secretKey: string;
	webhookSecret?: string;
}

/**
 * The seam. Both StripePaymentProvider and PaystackPaymentProvider
 * implement this. `ctx` is always the plugin's `PluginContext` (or the
 * subset of it — `http`, `log` — a provider needs); providers must use
 * `ctx.http.fetch` (never global `fetch`) so `allowedHosts` is honoured in
 * the sandbox, and `crypto.subtle` (never a Node `crypto` import) for any
 * HMAC/signature work, matching the sandbox-safety rules already
 * established in this fork's `stripe/*` modules.
 */
export interface PaymentProvider {
	/** Machine-readable id, e.g. "stripe" | "paystack". Used for the
	 * `settings:paymentProvider` switch and for tagging orders with which
	 * gateway processed them. */
	readonly id: string;

	/** Human label for admin UI / receipts, e.g. "Stripe" | "Paystack". */
	readonly label: string;

	/** ISO-4217 currencies this provider can charge in this deployment.
	 * Stripe: broad. Paystack: KES + a handful of others depending on the
	 * merchant's Paystack business country — Nondies' Paystack account is
	 * Kenya-only, so this fork's Paystack provider returns `["KES"]`. */
	supportedCurrencies(): string[];

	/** Initialise a hosted checkout/transaction. Returns a redirect URL —
	 * this interface deliberately does not model Stripe's embedded
	 * PaymentElement/client_secret flow, since Paystack (and most
	 * non-Stripe gateways) don't have an equivalent client-side primitive;
	 * hosted-redirect is the lowest common denominator every gateway
	 * supports, and it is also what "M-Pesa STK" checkout needs in
	 * practice (the STK push is triggered from Paystack's own hosted page
	 * once the customer picks the M-Pesa channel there). */
	initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult>;

	/** Verify a webhook's signature. Must be constant-time and must not
	 * assume any particular hash algorithm — Stripe uses HMAC-SHA256,
	 * Paystack uses HMAC-SHA512 (§4.2). */
	verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;

	/** Parse an already-signature-verified raw webhook body into a
	 * normalised event `routes/webhook.ts` can dispatch on without any
	 * gateway-specific branching. */
	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent;

	/** Issue a refund (full or partial) against a previously successful
	 * charge. */
	refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult>;

	/** Format a minor-units amount for display in the provider's own
	 * convention (mostly relevant for KSh vs USD-style gateways that
	 * expect different minor-unit granularity; both Stripe and Paystack
	 * use 2-decimal minor units for KES/USD, but this hook exists so a
	 * future 0-decimal-currency provider doesn't need interface changes). */
	formatAmount(money: Money): string;
}

/** The subset of PluginContext a PaymentProvider implementation may use.
 * Kept narrow and named so implementations can't reach into unrelated
 * plugin capabilities (storage, users, media) — payment providers only
 * ever need outbound HTTP + logging. */
export interface PaymentProviderRuntimeContext {
	http: { fetch: typeof fetch };
	log: {
		info: (msg: string, meta?: Record<string, unknown>) => void;
		warn: (msg: string, meta?: Record<string, unknown>) => void;
		error: (msg: string, meta?: Record<string, unknown>) => void;
	};
}

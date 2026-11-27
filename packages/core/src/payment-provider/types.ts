/**
 * PaymentProvider — gateway-agnostic checkout / webhook / refund seam.
 *
 * Hosted Stripe checkout, webhook verification, and admin refunds go through
 * this interface so additional processors (Paystack, a test mock, …) can plug
 * in without forking core. The built-in Stripe adapter wraps `src/stripe/*`
 * and must preserve current hosted Checkout, Tax, subscriptions, Connect,
 * and refund behaviour.
 *
 * Providers run in the EmDash sandbox: use `ctx.http.fetch` (never global
 * `fetch`) and `crypto.subtle` (never Node `crypto`).
 */

export interface PaymentProviderCustomer {
	email: string;
	name?: string;
	phone?: string;
}

export interface PaymentProviderAddress {
	firstName?: string;
	lastName?: string;
	line1?: string;
	line2?: string;
	city?: string;
	region?: string;
	postalCode?: string;
	country?: string;
	phone?: string;
}

/** One hosted-checkout line item. Amounts are integer minor units. */
export interface PaymentProviderLineItem {
	name: string;
	description?: string;
	amount: number;
	currency: string;
	quantity: number;
	images?: string[];
	metadata?: Record<string, string>;
	recurring?: {
		interval: "day" | "week" | "month" | "year";
		intervalCount: number;
	};
	taxBehavior?: "inclusive" | "exclusive";
}

export interface PaymentProviderShippingOption {
	id?: string;
	label: string;
	amount: number;
	currency: string;
	deliveryDays?: { minimum: number; maximum?: number };
	metadata?: Record<string, string>;
}

/**
 * One vendor's share of a split payment, computed by core from trusted cart
 * prices. Providers must not reprice or invent shares; they only route the
 * amounts to the account reference core supplies.
 */
export interface PaymentProviderSplitAllocation {
	vendorId: string;
	/**
	 * The provider's payout account id: a Flutterwave subaccount (`RS_…`) or a
	 * Paystack subaccount (`ACCT_…`).
	 */
	accountReference: string;
	/** Integer minor units owed to this vendor. */
	amountMinor: number;
}

/**
 * Hosted checkout request. Fields cover the Stripe Checkout capabilities
 * current routes actually send (shipping, billing collection, Stripe Tax,
 * subscription mode/trials/metadata, Connect transfer data + application
 * fees, discounts). Adapters ignore fields they do not support.
 */
export interface InitCheckoutInput {
	/** Our order-draft id — echoed in metadata so webhooks can correlate. */
	orderDraftId: string;
	/** Integer minor units, cart total. */
	amount: number;
	currency: string;
	customer: PaymentProviderCustomer;
	lineItems: PaymentProviderLineItem[];
	successUrl: string;
	cancelUrl: string;
	/** `payment` (default) or `subscription`. Must not be hard-coded by adapters. */
	mode?: "payment" | "subscription";
	billingAddress?: PaymentProviderAddress;
	shippingAddress?: PaymentProviderAddress;
	shippingOptions?: PaymentProviderShippingOption[];
	shippingAddressCollection?: { allowedCountries: string[] };
	billingAddressCollection?: "auto" | "required";
	automaticTax?: boolean;
	allowPromotionCodes?: boolean;
	clientReferenceId?: string;
	metadata?: Record<string, string>;
	/** Copied onto the PaymentIntent Stripe creates (`mode=payment` only). */
	paymentIntentMetadata?: Record<string, string>;
	paymentIntentReceiptEmail?: string;
	/** Connect destination charge routing (`mode=payment` only). */
	transferData?: { destination: string; amount?: number };
	applicationFeeAmount?: number;
	/** Copied onto the Subscription Stripe creates (`mode=subscription`). */
	subscriptionMetadata?: Record<string, string>;
	subscriptionTrialPeriodDays?: number;
	/** Provider coupon ids (Stripe Coupon id from createOneTimeCoupon). */
	discounts?: Array<{ coupon: string }>;
	/** Hint for gateways that restrict methods on the hosted page. */
	preferredChannels?: string[];
	/**
	 * Per-vendor shares for a split payment. Present only when the provider
	 * declares `capabilities.splits` and the cart has vendor-owned items.
	 * Sums to `total - platformRemainderMinor`.
	 */
	allocations?: PaymentProviderSplitAllocation[];
	/** Amount retained by the platform after every vendor allocation, in minor units. */
	platformRemainderMinor?: number;
	/**
	 * `hosted` (default): return a redirect. `on_page`: return an `on_page`
	 * result for the storefront to open over the page. Core asks for
	 * `on_page` only from providers that declare it in `checkoutStyles`.
	 */
	checkoutStyle?: CheckoutStyle;
}

/** How customers pay: on the provider's hosted page, or over the store's page. */
export type CheckoutStyle = "hosted" | "on_page";

/**
 * Browser side of on-page checkout. A provider package's client entry
 * registers one on `window.DashCommerceCheckoutClients[providerId]`, and the
 * storefront calls `open` with the `client` data from an `on_page` result.
 * Callbacks only steer the customer: payment is confirmed by the signed
 * webhook and the provider's live status, never by the browser.
 */
export interface OnPageCheckoutClient {
	open(
		client: Record<string, string>,
		callbacks: {
			/** The customer finished at the provider; go to the return URL. */
			onFinished(): void;
			/** The customer closed the provider's window without paying. */
			onClosed(): void;
			onError(message: string): void;
		},
	): void;
}

declare global {
	interface Window {
		DashCommerceCheckoutClients?: Record<string, OnPageCheckoutClient>;
	}
}

export type InitCheckoutResult =
	| {
			kind: "redirect";
			/** Hosted session id (Stripe Checkout Session id, Paystack access code, …). */
			checkoutReference: string;
			redirectUrl: string;
	  }
	| {
			kind: "pending";
			checkoutReference: string;
	  }
	| {
			/**
			 * Pay over the store's page. `client` is handed to the provider's
			 * browser client (see the package's checkout-client entry), e.g.
			 * Paystack's `{ accessCode }`. Never trusted as proof of payment.
			 * Public: `create-session` sends it to the browser as JSON, so
			 * never put a secret key or webhook secret in it.
			 */
			kind: "on_page";
			checkoutReference: string;
			client: Record<string, string>;
	  };

export interface VerifyWebhookInput {
	/** Exact raw body bytes as received — never a re-serialised parse. */
	rawBody: string;
	/** The header that routed this webhook to the provider (see `webhookHeaders`). */
	signatureHeader: string;
	secret: string;
	/**
	 * Every request header, for schemes that sign over more than one
	 * (Standard Webhooks: `webhook-id`, `webhook-timestamp`,
	 * `webhook-signature`). Core's webhook route always passes it.
	 */
	headers?: Headers;
	/**
	 * The provider's saved credentials, for schemes that sign a header with
	 * the API key rather than the webhook secret (Paystack's
	 * `x-paystack-signature`). Core's webhook route always passes it.
	 */
	credentials?: PaymentProviderCredentials;
}

export interface VerifyWebhookResult {
	ok: boolean;
	reason?: string;
}

/**
 * Normalised webhook event after signature verification.
 *
 * `checkoutReference` is the hosted session / access code.
 * `paymentReference` is the captured payment id used for refunds
 * (Stripe PaymentIntent id — never a Checkout Session id).
 * `providerEventId` is the provider's native event id (Stripe `event.id`)
 * and is what webhook routes use for delivery dedupe.
 */
export type NormalizedPaymentEvent =
	| {
			type: "charge.succeeded";
			orderDraftId: string;
			providerId: string;
			providerEventId: string;
			checkoutReference?: string;
			paymentReference: string;
			amount: number;
			currency: string;
			customer: PaymentProviderCustomer;
			shippingAddress?: PaymentProviderAddress;
			billingAddress?: PaymentProviderAddress;
			channel?: string;
			raw: unknown;
	  }
	| {
			type: "charge.failed";
			orderDraftId: string;
			providerId: string;
			providerEventId: string;
			checkoutReference?: string;
			paymentReference?: string;
			reason?: string;
			raw: unknown;
	  }
	| {
			/**
			 * A refund this store created moved on at the provider (e.g.
			 * Paystack's `refund.processed`). `providerRefundId` is the id
			 * `refund()` returned. Settled refunds never move back to pending.
			 */
			type: "refund.updated";
			providerId: string;
			providerEventId: string;
			providerRefundId: string;
			status: "pending" | "succeeded" | "failed";
			paymentReference?: string;
			raw: unknown;
	  }
	| {
			type: "unhandled";
			providerEventType: string;
			providerEventId?: string;
			raw: unknown;
	  };

export interface CreateRefundInput {
	/**
	 * Captured payment id from the original charge (Stripe PaymentIntent id).
	 * Must not be a checkout/session reference.
	 */
	paymentReference: string;
	/**
	 * Caller-supplied unique id for this refund attempt. Used as the
	 * provider idempotency key so two legitimate partial refunds of the
	 * same amount against the same payment do not collapse.
	 */
	refundRequestId: string;
	/** Minor units. Omit for a full refund. */
	amount?: number;
	currency: string;
	reason?: string;
	metadata?: Record<string, string>;
}

export interface RefundResult {
	providerRefundId: string;
	refundRequestId: string;
	status: "pending" | "succeeded" | "failed";
	amount: number;
	currency: string;
}

export interface PaymentProviderCredentials {
	secretKey: string;
	webhookSecret?: string;
	/**
	 * The provider's browser-side public key, when it has one. Used by
	 * providers whose on-page checkout needs it in the browser (Flutterwave
	 * Inline). Never a secret, but saved with the same settings plumbing.
	 */
	publicKey?: string;
}

/** Subset of PluginContext a provider may use. */
export interface PaymentProviderRuntimeContext {
	http?: {
		fetch: (url: string, init?: RequestInit) => Promise<Response>;
	};
	log: {
		info: (msg: string, meta?: Record<string, unknown>) => void;
		warn: (msg: string, meta?: Record<string, unknown>) => void;
		error: (msg: string, meta?: Record<string, unknown>) => void;
	};
}

export interface PaymentProviderCapabilities {
	/** Merchant-engine discounts on hosted checkout (Stripe one-time coupons). */
	coupons?: boolean;
	/** Connect / destination charges + application fees. */
	connect?: boolean;
	/** Recurring `mode: "subscription"` checkout. */
	subscriptions?: boolean;
	/**
	 * Split one payment across vendor payout accounts (Flutterwave
	 * subaccounts, Paystack splits). Core then sends `allocations` on
	 * `initCheckout`.
	 */
	splits?: boolean;
}

/** How the admin settings form shows and validates one credential. */
export interface PaymentProviderCredentialField {
	label?: string;
	/** Accepted prefixes, e.g. `["sk_test_", "rk_test_"]`. Omit to accept any non-empty value. */
	prefixes?: readonly string[];
	help?: string;
}

/** What a provider's `checkConnection` reports to the Settings button. */
export interface ConnectionCheckResult {
	ok: boolean;
	/** One line for the merchant, e.g. "Connected in test mode." */
	message: string;
	/** Which kind of key is saved, when the provider can tell. */
	mode?: "test" | "live";
}

export interface PaymentStatusResult {
	status: "pending" | "succeeded" | "failed";
	paymentReference?: string;
	amount?: number;
	currency?: string;
	reason?: string;
}

export interface PaymentProvider {
	readonly id: string;
	readonly label: string;
	/**
	 * Features this adapter actually implements. Missing/false means
	 * hosted checkout must reject the cart rather than silently drop
	 * coupons, Connect splits, or subscriptions.
	 */
	readonly capabilities?: PaymentProviderCapabilities;

	/**
	 * Request headers that identify this provider's webhooks, in order of
	 * preference, e.g. `["paystack-signature", "x-paystack-signature"]`.
	 * `x-<id>-signature` is always recognised as well. The first one present
	 * is passed as `signatureHeader`. `stripe-signature` is reserved.
	 */
	readonly webhookHeaders?: readonly string[];

	/** Checkout styles this provider supports. Defaults to `["hosted"]`. */
	readonly checkoutStyles?: readonly CheckoutStyle[];

	/** One line for the provider card in Settings, e.g. "Card and M-Pesa in Kenya". */
	readonly description?: string;

	/**
	 * The provider's official logo for its card in Settings: an https URL or
	 * a `data:image/…` URI. Core ships no third-party logos; without one the
	 * card shows a lettered tile in `brandColour` (#rrggbb).
	 */
	readonly logo?: string;
	readonly brandColour?: string;

	/**
	 * True when the provider's hosted page collects the customer's email and
	 * address itself (Stripe Checkout does). Otherwise the storefront must
	 * collect them, and checkout refuses to start a payment without them.
	 */
	readonly collectsCustomerDetails?: boolean;

	/**
	 * Credentials the merchant enters in admin settings, saved as
	 * `settings:<id>SecretKey`, `settings:<id>WebhookSecret` and
	 * `settings:<id>PublicKey`.
	 */
	readonly credentialFields?: {
		secretKey?: PaymentProviderCredentialField;
		webhookSecret?: PaymentProviderCredentialField;
		/**
		 * The browser-side public key, for on-page checkout that needs one
		 * (Flutterwave Inline). Settings shows the field only when declared.
		 */
		publicKey?: PaymentProviderCredentialField;
	};

	/** True if this provider can charge `currency` (ISO-4217). */
	supportsCurrency(currency: string): boolean;

	initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult>;

	verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;

	/**
	 * Parse an already-verified raw body. Must return `unhandled` (not throw)
	 * on malformed JSON or unknown event types.
	 */
	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent;

	refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult>;

	formatAmount(amount: number, currency: string): string;

	/**
	 * Optional live retrieve. Generic webhooks call this when present so
	 * a spoofed amount/currency in the payload cannot silently match a
	 * cart in a different currency.
	 */
	getPaymentStatus?(
		ctx: PaymentProviderRuntimeContext,
		paymentReference: string,
		credentials: PaymentProviderCredentials,
	): Promise<PaymentStatusResult>;

	/**
	 * Optional check behind the "Test connection" button in Settings: one
	 * read-only call with the saved credentials. It must not create or change
	 * anything at the provider. Return `ok: false` with a message the merchant
	 * can act on (wrong key, missing permission); don't throw for those.
	 */
	checkConnection?(
		ctx: PaymentProviderRuntimeContext,
		credentials: PaymentProviderCredentials,
	): Promise<ConnectionCheckResult>;
}

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
}

/** How the admin settings form shows and validates one credential. */
export interface PaymentProviderCredentialField {
	label?: string;
	/** Accepted prefixes, e.g. `["sk_test_", "rk_test_"]`. Omit to accept any non-empty value. */
	prefixes?: readonly string[];
	help?: string;
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

	/**
	 * True when the provider's hosted page collects the customer's email and
	 * address itself (Stripe Checkout does). Otherwise the storefront must
	 * collect them, and checkout refuses to start a payment without them.
	 */
	readonly collectsCustomerDetails?: boolean;

	/**
	 * Credentials the merchant enters in admin settings, saved as
	 * `settings:<id>SecretKey` and `settings:<id>WebhookSecret`.
	 */
	readonly credentialFields?: {
		secretKey?: PaymentProviderCredentialField;
		webhookSecret?: PaymentProviderCredentialField;
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
}

/**
 * DashCommerce — core type surface.
 *
 * All entities — products, variants, carts, orders, customers, coupons,
 * shipping, tax, subscriptions, reviews, vendors, inventory, downloads —
 * are defined here. These types are used in:
 *
 *   - plugin storage collection row shapes (`ctx.storage.<col>.put(id, T)`)
 *   - route input/output shapes
 *   - admin React UI
 *   - storefront Astro component props
 *
 * Keep this file free of runtime imports beyond `./money`.
 */

import type { CurrencyCode, Money } from "./money";

export type { CurrencyCode, Money };

// ────────────────────────────────────────────────────────────────────────────
// Generic
// ────────────────────────────────────────────────────────────────────────────

export type CountryCode = string; // ISO 3166-1 alpha-2
export type RegionCode = string; // subdivision code (ISO 3166-2 part)

export type IsoDateTime = string; // ISO 8601 UTC

export interface Address {
	firstName: string;
	lastName: string;
	company?: string;
	line1: string;
	line2?: string;
	city: string;
	region: string;
	postalCode: string;
	country: CountryCode;
	phone?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Product (host content collection rows)
// ────────────────────────────────────────────────────────────────────────────

export type ProductType = "simple" | "variable" | "grouped" | "external" | "subscription";

export type StockStatus = "instock" | "outofstock" | "onbackorder";
export type BackorderPolicy = "no" | "yes" | "notify";

export interface PriceEntry {
	amount: number; // minor units
	compareAtAmount?: number; // strikethrough price
}

/** Keyed by currency code, e.g. `{ USD: { amount: 1999 }, EUR: { amount: 1899 } }` */
export type PriceMap = Record<CurrencyCode, PriceEntry>;

export interface DownloadableFile {
	name: string;
	/** emdash media id. Preferred when the file is stored in emdash storage. */
	mediaId?: string;
	/** External URL (CDN, S3, etc). Mutually exclusive with mediaId. */
	url?: string;
	fileSizeBytes?: number;
}

export interface SubscriptionConfig {
	interval: "day" | "week" | "month" | "year";
	intervalCount: number;
	trialDays?: number;
	/** Stripe Price id if pre-provisioned in Stripe; otherwise we create a Price at checkout. */
	stripePriceId?: string;
}

/**
 * Product fields written to the host's `products` content collection's
 * `data` object. The base emdash content fields (id/slug/status/createdAt…)
 * live on the content item envelope.
 */
export interface ProductFields {
	title: string;
	type: ProductType;
	prices: PriceMap;
	sku: string;
	manageStock: boolean;
	stockQuantity: number | null;
	stockStatus: StockStatus;
	backorders: BackorderPolicy;
	lowStockThreshold: number | null;
	belowThresholdAt: IsoDateTime | null; // set when stock first crosses below threshold
	weightGrams: number | null;
	taxClass: string; // references ShippingClass.slug
	shippingClassSlug: string | null;
	featured: boolean;
	isDownloadable: boolean;
	isVirtual: boolean;
	downloadableFiles?: DownloadableFile[];
	vendorId?: string;
	subscriptionConfig?: SubscriptionConfig;
	// grouped
	childProductIds?: string[];
	// external
	productUrl?: string;
	buttonText?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Product variants (plugin storage collection `product_variants`)
// ────────────────────────────────────────────────────────────────────────────

export interface ProductVariant {
	id: string;
	productId: string;
	sku: string;
	prices: PriceMap;
	stockQuantity: number | null;
	weightGrams: number | null;
	/** e.g. `{ size: "M", color: "red" }` */
	attributes: Record<string, string>;
	imageMediaId?: string;
	isActive: boolean;
	createdAt: IsoDateTime;
	updatedAt: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Cart (KV-backed, session-scoped)
// ────────────────────────────────────────────────────────────────────────────

export interface CartLineItem {
	lineId: string; // stable within cart
	productId: string;
	variantId?: string;
	quantity: number;
	unitPrice: Money; // resolved server-side per cart.currency
	lineSubtotal: Money;
	title: string;
	imageMediaId?: string;
	isDigital: boolean;
	vendorId?: string;
	subscriptionConfig?: SubscriptionConfig;
	shippingClassSlug?: string | null;
	weightGrams?: number | null;
}

export interface AppliedCoupon {
	code: string;
	discountAmount: Money;
	freeShipping: boolean;
}

export interface TaxLine {
	label: string;
	amount: Money;
	rate: number; // percentage
}

export interface CartState {
	sessionId: string;
	userId?: string;
	currency: CurrencyCode;
	items: CartLineItem[];
	coupons: AppliedCoupon[];
	shippingAddress?: Address;
	billingAddress?: Address;
	shippingMethod?: { id: string; label: string; amount: Money };
	taxLines: TaxLine[];
	subtotal: Money;
	discountTotal: Money;
	shippingTotal: Money;
	taxTotal: Money;
	total: Money;
	customerEmail?: string; // set when user hits checkout email step
	notes?: string;
	createdAt: IsoDateTime;
	updatedAt: IsoDateTime;
	abandonedEmailSentAt?: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Order + order items + refunds (plugin storage)
// ────────────────────────────────────────────────────────────────────────────

export type OrderStatus =
	| "pending"
	| "processing"
	| "on-hold"
	| "completed"
	| "cancelled"
	| "refunded"
	| "partially-refunded"
	| "failed";

export type PaymentStatus = "pending" | "paid" | "failed" | "refunded" | "partially-refunded";

export interface VendorSplit {
	vendorId: string;
	stripeAccountId: string;
	amount: Money; // vendor's portion
	platformFee: Money; // our cut
	stripeTransferId?: string;
	stripePaymentIntentId?: string; // when multi-PI model is used
}

/** One vendor's share of a split payment, as the provider settled it. */
export interface OrderProviderSplitAllocation {
	/** Matched vendor, when core can resolve the provider account reference. */
	vendorId?: string;
	accountReference: string;
	amount: Money;
}

/**
 * Provider-reported settlement of a split payment, stored for reconciliation.
 * This never changes the shares core computed; it records what the provider
 * says each account actually earned, plus its fee and the platform remainder.
 */
export interface OrderProviderSplit {
	providerId: string;
	allocations: OrderProviderSplitAllocation[];
	platformRemainder?: Money;
	providerFee?: Money;
	capturedAt: IsoDateTime;
}

export interface Order {
	id: string;
	orderNumber: string; // human-facing, zero-padded incrementing
	status: OrderStatus;
	paymentStatus: PaymentStatus;
	customerId: string;
	customerEmail: string;
	currency: CurrencyCode;
	billingAddress: Address;
	shippingAddress: Address;
	shippingMethodId?: string;
	shippingMethodLabel?: string;
	subtotal: Money;
	discountTotal: Money;
	shippingTotal: Money;
	taxTotal: Money;
	total: Money;
	paidTotal: Money;
	refundedTotal: Money;
	taxLines: TaxLine[];
	couponCodes: string[];
	vendorSplits?: VendorSplit[];
	/** Provider-reported settlement of a split payment, for reconciliation. */
	providerSplits?: OrderProviderSplit;
	subscriptionIds?: string[];
	stripePaymentIntentId: string; // unique — Stripe PaymentIntent id
	/**
	 * Gateway that captured this payment. Unset means Stripe, matching
	 * existing rows written before PaymentProvider existed.
	 */
	providerId?: string;
	/**
	 * Captured payment id used for refunds. Unset means
	 * `stripePaymentIntentId` (never a Checkout Session id).
	 */
	paymentReference?: string;
	/** Hosted checkout session / access-code reference, when applicable. */
	checkoutReference?: string;
	stripeCustomerId?: string;
	stripeChargeId?: string;
	paymentMethodType?: string; // card, link, applepay, …
	customerNote?: string;
	metadata?: Record<string, unknown>;
	ipAddress?: string;
	userAgent?: string;
	createdAt: IsoDateTime;
	updatedAt: IsoDateTime;
	paidAt?: IsoDateTime;
	completedAt?: IsoDateTime;
	cancelledAt?: IsoDateTime;
}

export interface OrderItem {
	id: string;
	orderId: string;
	productId: string;
	variantId?: string;
	sku: string;
	name: string;
	attributes?: Record<string, string>;
	quantity: number;
	unitPrice: Money;
	lineSubtotal: Money;
	discountAmount: Money;
	taxAmount: Money;
	total: Money;
	isDigital: boolean;
	vendorId?: string;
	subscriptionConfig?: SubscriptionConfig;
}

export interface Refund {
	id: string;
	orderId: string;
	amount: Money;
	reason?: string;
	status: "pending" | "succeeded" | "failed";
	stripeRefundId: string; // unique
	/** Caller-supplied refund attempt id used as the provider idempotency key. */
	refundRequestId?: string;
	lineItemRefunds?: Array<{
		orderItemId: string;
		quantity: number;
		amount: Money;
	}>;
	restocked: boolean;
	/**
	 * The order's status when this refund was recorded. If every refund on
	 * the order later fails, the order goes back to the status its first
	 * refund recorded.
	 */
	orderStatusBefore?: OrderStatus;
	createdAt: IsoDateTime;
	createdByUserId?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Customers
// ────────────────────────────────────────────────────────────────────────────

export interface Customer {
	id: string;
	email: string; // unique
	firstName?: string;
	lastName?: string;
	phone?: string;
	userId?: string; // link to emdash user
	stripeCustomerId?: string;
	defaultBillingAddressId?: string;
	defaultShippingAddressId?: string;
	ordersCount: number;
	/** Total spent keyed by currency, in minor units. */
	totalSpent: Record<CurrencyCode, number>;
	acceptsMarketing: boolean;
	createdAt: IsoDateTime;
	updatedAt: IsoDateTime;
}

export interface CustomerAddress extends Address {
	id: string;
	customerId: string;
	isDefaultBilling?: boolean;
	isDefaultShipping?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Coupons
// ────────────────────────────────────────────────────────────────────────────

export type DiscountType =
	| "percent_cart"
	| "fixed_cart"
	| "percent_product"
	| "fixed_product"
	| "free_shipping";

export interface Coupon {
	id: string;
	code: string; // unique, case-insensitive on input
	description?: string;
	discountType: DiscountType;
	discountValue: number; // percent (0-100) or minor units
	/** Required for `fixed_*` types; must match cart currency to apply. */
	currency?: CurrencyCode;
	status: "active" | "inactive";
	startsAt?: IsoDateTime;
	endsAt?: IsoDateTime;
	minAmount?: Money;
	maxAmount?: Money;
	includedProductIds?: string[];
	excludedProductIds?: string[];
	includedCategorySlugs?: string[];
	excludedCategorySlugs?: string[];
	excludeSaleItems: boolean;
	usageLimit?: number; // global cap
	usageLimitPerCustomer?: number;
	usageCount: number;
	individualUse: boolean; // if true, cannot combine with other coupons
	createdAt: IsoDateTime;
	updatedAt: IsoDateTime;
}

export interface CouponUsage {
	id: string;
	/**
	 * Synthetic `${couponCode}:${orderId}` — unique-indexed on the
	 * `coupon_usage` storage collection so concurrent webhook retries
	 * for the same order don't double-count. See `orders/create.ts`.
	 */
	dedupKey: string;
	couponCode: string;
	customerId?: string;
	orderId: string;
	discountAmount: Money;
	createdAt: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Shipping
// ────────────────────────────────────────────────────────────────────────────

export interface ShippingZone {
	id: string;
	name: string;
	locations: Array<{ country: CountryCode; regions?: RegionCode[] }>;
	order: number;
	createdAt: IsoDateTime;
	updatedAt: IsoDateTime;
}

export type ShippingMethodType = "flat_rate" | "free_shipping" | "local_pickup" | "weight_based";

export type ShippingMethodConfig =
	| {
			type: "flat_rate";
			amount: Money;
			/** Optional per-shipping-class overrides. */
			shippingClassRates?: Record<string, Money>;
	  }
	| {
			type: "free_shipping";
			minimumAmount?: Money;
			requiresCoupon?: boolean;
	  }
	| { type: "local_pickup"; amount?: Money }
	| {
			type: "weight_based";
			currency: CurrencyCode;
			base: Money;
			/** Additional minor units per gram. */
			perGram: number;
	  };

export interface ShippingMethod {
	id: string;
	zoneId: string;
	type: ShippingMethodType;
	title: string;
	enabled: boolean;
	config: ShippingMethodConfig;
	order: number;
}

export interface ShippingClass {
	id: string;
	slug: string; // unique
	name: string;
	description?: string;
}

export interface ShippingRateOption {
	methodId: string;
	label: string;
	amount: Money;
	deliveryEstimate?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Tax
// ────────────────────────────────────────────────────────────────────────────

export type TaxMode = "flat" | "table" | "stripe_tax";

export interface TaxRate {
	id: string;
	country: CountryCode;
	region?: RegionCode;
	postalCode?: string; // prefix or exact
	taxClass: string; // default "standard"
	rate: number; // percentage
	name: string;
	compound: boolean;
	appliesToShipping: boolean;
	priority: number; // lower runs first
}

// ────────────────────────────────────────────────────────────────────────────
// Subscriptions
// ────────────────────────────────────────────────────────────────────────────

export type SubscriptionStatus =
	| "active"
	| "trialing"
	| "past_due"
	| "canceled"
	| "unpaid"
	| "incomplete"
	| "incomplete_expired"
	| "paused";

export interface Subscription {
	id: string;
	stripeSubscriptionId: string; // unique
	customerId: string;
	productId: string;
	variantId?: string;
	status: SubscriptionStatus;
	currency: CurrencyCode;
	unitAmount: Money;
	quantity: number;
	interval: "day" | "week" | "month" | "year";
	intervalCount: number;
	trialEndsAt?: IsoDateTime;
	currentPeriodStart: IsoDateTime;
	currentPeriodEnd: IsoDateTime;
	cancelAtPeriodEnd: boolean;
	canceledAt?: IsoDateTime;
	createdAt: IsoDateTime;
	updatedAt: IsoDateTime;
}

export interface SubscriptionInvoice {
	id: string;
	stripeInvoiceId: string; // unique
	subscriptionId: string;
	amount: Money;
	status: "draft" | "open" | "paid" | "uncollectible" | "void";
	paidAt?: IsoDateTime;
	attemptCount: number;
	createdAt: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Reviews
// ────────────────────────────────────────────────────────────────────────────

export type ReviewStatus = "pending" | "approved" | "rejected" | "spam";

export interface Review {
	id: string;
	productId: string;
	customerId?: string;
	customerEmail?: string;
	customerName: string;
	rating: number; // integer 1-5
	title?: string;
	body: string;
	status: ReviewStatus;
	verifiedPurchase: boolean;
	createdAt: IsoDateTime;
	moderatedAt?: IsoDateTime;
	moderatedByUserId?: string;
}

export interface ReviewSummary {
	productId: string;
	averageRating: number;
	count: number;
	distribution: Record<1 | 2 | 3 | 4 | 5, number>;
	updatedAt: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Vendors (Stripe Connect)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A vendor's payout account at one payment provider. Flutterwave uses a
 * collection subaccount (`RS_...`); Stripe keeps using `stripeAccountId`.
 * The account reference is provider-owned and never a secret.
 */
export interface VendorPaymentAccount {
	accountReference: string;
	status: "active" | "pending" | "disabled";
	/** Account holder name returned by the provider's account resolution. */
	accountName?: string;
	bankName?: string;
	bankCode?: string;
	/** ISO-2 country of the payout account. */
	country?: string;
	/** Last four digits, never the full account number. */
	maskedAccountNumber?: string;
	/** Settlement currency, when the provider ties the account to one. */
	currency?: CurrencyCode;
	/** Human label for the admin, e.g. the bank name. */
	label?: string;
	/** Provider-specific extras, e.g. the numeric subaccount id. */
	metadata?: Record<string, string>;
	createdAt?: IsoDateTime;
	updatedAt: IsoDateTime;
}

export interface Vendor {
	id: string;
	/**
	 * Stripe Connect account id (`acct_…`). Absent for vendors paid through a
	 * different provider. The unique index treats a missing field as NULL, so
	 * any number of non-Stripe vendors can exist; two vendors cannot share an
	 * `acct_…`.
	 */
	stripeAccountId?: string;
	name: string;
	email: string;
	onboardingStatus: "pending" | "active" | "restricted";
	platformFeePercent: number; // override of global setting; 0-100
	detailsSubmitted: boolean;
	chargesEnabled: boolean;
	payoutsEnabled: boolean;
	/**
	 * Payout accounts for providers other than Stripe, keyed by provider id.
	 * Stripe Connect keeps its own fields above.
	 */
	paymentAccounts?: Record<string, VendorPaymentAccount>;
	createdAt: IsoDateTime;
	updatedAt: IsoDateTime;
}

export interface VendorPayout {
	id: string;
	vendorId: string;
	stripePayoutId: string; // unique
	amount: Money;
	status: string; // Stripe payout.status
	arrivalDate: IsoDateTime;
	createdAt: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Inventory
// ────────────────────────────────────────────────────────────────────────────

export type InventoryLedgerReason =
	| "order_paid"
	| "order_cancelled"
	| "refund"
	| "admin_adjustment"
	| "initial_stock"
	| "restock"
	| "refund_failed";

export interface InventoryLedgerEntry {
	id: string;
	productId: string;
	variantId?: string;
	delta: number; // negative = decrement
	newStockLevel: number;
	reason: InventoryLedgerReason;
	orderId?: string;
	refundId?: string;
	userId?: string;
	note?: string;
	createdAt: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Digital download grants
// ────────────────────────────────────────────────────────────────────────────

export interface DownloadGrant {
	id: string;
	orderId: string;
	orderItemId: string;
	productId: string;
	customerEmail: string;
	fileIndex: number;
	fileName: string;
	mediaId?: string;
	externalUrl?: string;
	maxUses: number;
	usesCount: number;
	expiresAt: IsoDateTime;
	createdAt: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Stripe event dedup log (plugin storage)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Idempotency record for a Stripe webhook delivery. Written once per
 * `event.id` before any side-effectful handler runs. Subsequent deliveries
 * of the same event hit a unique-violation on put and are treated as
 * no-ops.
 */
export interface StripeEventRecord {
	id: string;
	stripeEventId: string;
	type: string;
	createdAt: IsoDateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Stock soft-lock (KV, keyed `lock:{orderDraftId}`)
// ────────────────────────────────────────────────────────────────────────────

export interface StockLockEntry {
	productId: string;
	variantId?: string;
	quantity: number;
}

export interface StockLock {
	orderDraftId: string;
	sessionId: string;
	stripePaymentIntentId?: string;
	entries: StockLockEntry[];
	expiresAt: IsoDateTime;
	createdAt: IsoDateTime;
}

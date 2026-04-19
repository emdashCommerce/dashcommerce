/**
 * Storage collection declarations for the descriptor.
 *
 * emdash gives plugins indexed document collections via `ctx.storage.<name>`.
 * Each collection declares indexed columns (for equality/range queries) and
 * unique indexes (for `putMany` idempotency + lookups).
 *
 * NOTE: `PluginDescriptor.storage` (build-time) only accepts flat string
 * indexes — composite tuples are not supported here (they exist in the
 * runtime `PluginDefinition` shape). We denormalize composites into single
 * indexes and rely on `ctx.storage.*.query({ where })` with compound
 * predicates at the application layer.
 */

import type { PluginDescriptor } from "emdash";

type StorageConfig = NonNullable<PluginDescriptor["storage"]>;

export const DASHCOMMERCE_STORAGE: StorageConfig = {
	orders: {
		indexes: ["customerId", "status", "paymentStatus", "createdAt", "paidAt"],
		uniqueIndexes: ["stripePaymentIntentId", "orderNumber"],
	},
	order_items: {
		indexes: ["orderId", "productId", "variantId"],
	},
	refunds: {
		indexes: ["orderId", "createdAt"],
		uniqueIndexes: ["stripeRefundId"],
	},
	customers: {
		indexes: ["userId", "createdAt"],
		uniqueIndexes: ["email"],
	},
	customer_addresses: {
		indexes: ["customerId"],
	},
	product_variants: {
		indexes: ["productId", "isActive"],
		uniqueIndexes: ["sku"],
	},
	coupons: {
		indexes: ["status", "endsAt", "createdAt"],
		uniqueIndexes: ["code"],
	},
	coupon_usage: {
		indexes: ["couponCode", "customerId", "orderId", "createdAt"],
		// `dedupKey` is a synthetic field of form "${couponCode}:${orderId}".
		// Unique-indexed so we can safely upsert usage rows in
		// concurrent webhook-driven order creations without double-
		// counting. A race between two concurrent orders both inserting
		// for different orderIds is fine (distinct keys); a race between
		// two webhook retries for the *same* order fails the second put
		// with a unique-violation, which the caller treats as success.
		uniqueIndexes: ["dedupKey"],
	},
	shipping_zones: {
		indexes: ["order"],
	},
	shipping_methods: {
		indexes: ["zoneId", "type", "enabled"],
	},
	shipping_classes: {
		uniqueIndexes: ["slug"],
	},
	tax_rates: {
		indexes: ["country", "region", "taxClass", "priority"],
	},
	subscriptions: {
		indexes: ["customerId", "status", "currentPeriodEnd", "createdAt"],
		uniqueIndexes: ["stripeSubscriptionId"],
	},
	subscription_invoices: {
		indexes: ["subscriptionId", "status", "createdAt"],
		uniqueIndexes: ["stripeInvoiceId"],
	},
	reviews: {
		indexes: ["productId", "status", "createdAt"],
	},
	review_summaries: {
		indexes: ["updatedAt"],
	},
	vendors: {
		indexes: ["email", "onboardingStatus", "createdAt"],
		uniqueIndexes: ["stripeAccountId"],
	},
	vendor_payouts: {
		indexes: ["vendorId", "createdAt"],
		uniqueIndexes: ["stripePayoutId"],
	},
	inventory_ledger: {
		indexes: ["productId", "variantId", "orderId", "createdAt"],
	},
	download_grants: {
		indexes: ["orderId", "customerEmail", "expiresAt"],
	},
	/**
	 * Idempotency log for Stripe webhook deliveries.
	 *
	 * Every verified webhook records its `stripe_event_id` here before
	 * touching any other collection. The unique index makes the second
	 * delivery a no-op insert attempt; the handler treats the conflict
	 * as "already processed" and returns 200 without side effects.
	 *
	 * This is defense in depth on top of the per-resource dedup keys
	 * (stripePaymentIntentId, stripeRefundId, stripePayoutId, etc.):
	 * those protect resource creation, but handler-level event dedup
	 * also prevents re-running operations like dunning emails on
	 * duplicate deliveries.
	 */
	stripe_events: {
		indexes: ["type", "createdAt"],
		uniqueIndexes: ["stripeEventId"],
	},
};

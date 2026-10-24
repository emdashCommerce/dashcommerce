/**
 * Code shared with `@dashcommerce/core`.
 *
 * Lite imports these modules straight from core's source so both plugins
 * run one implementation of money math, cart totals, product field
 * normalization, price resolution, Stripe request encoding, Stripe webhook
 * signature checks and the order state machine. The Lite bundler inlines
 * them into `backend.js`.
 *
 * Every module re-exported here must stay sandbox-safe: no React, no Astro,
 * no `node:*`, and only type imports from `emdash`. The test in
 * `test/unit/shared-imports.test.ts` walks the import graph of this file
 * and fails if a module breaks that rule.
 */

export {
	add,
	format,
	minorUnitsFactor,
	money,
	zero,
	type CurrencyCode,
	type Money,
} from "../../core/src/money";
export { type PricingPolicy, recalculate } from "../../core/src/cart/calculate";
export { newCart } from "../../core/src/cart/store";
export { normalizeProductFields } from "../../core/src/products/normalize";
export { resolvePrice } from "../../core/src/products/pricing";
export { verifyStripeSignature } from "../../core/src/stripe/webhook-verify";
export {
	type CheckoutLineItem,
	createCheckoutSession,
	type CreateCheckoutSessionInput,
	type StripeCheckoutSession,
	type StripeSessionAddress,
} from "../../core/src/stripe/checkout-sessions";
export { StripeApiError } from "../../core/src/stripe/client";
export {
	canTransition,
	deriveOrderStatusFromRefunds,
	derivePaymentStatus,
} from "../../core/src/orders/status";
export { randomId } from "../../core/src/util/ids";
export type {
	CartLineItem,
	CartState,
	OrderStatus,
	PaymentStatus,
	ProductFields,
} from "../../core/src/types";

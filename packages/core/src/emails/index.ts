/**
 * Central re-export for the transactional email module.
 *
 * Phase 15 consolidates all commerce-triggered email composition under
 * `src/emails/*`. Each module exports a pure `compose*()` builder
 * (returning `{ subject, text, html }`) and, where there's a single
 * obvious delivery path, a matching `send*()` that pulls data from
 * `PluginContext` and swallows provider errors via `ctx.log.warn`.
 *
 * Event map:
 *   - order receipt              → routes/webhook.ts (PI + Checkout)
 *   - refund receipt             → routes/webhook.ts (charge.refunded)
 *   - abandoned cart             → abandoned-cart/recover.ts cron
 *   - dunning / payment-failed   → subscriptions/dunning.ts
 *   - subscription renewed       → routes/webhook.ts (invoice.payment_succeeded, cycle)
 *   - review request             → routes/admin-api.ts (order status → completed)
 *   - vendor invite              → vendors/onboarding.ts
 *   - vendor activated           → routes/webhook.ts (account.updated)
 *   - vendor payout              → routes/webhook.ts (payout.paid)
 */

export {
	composeAbandonedCart,
} from "./abandoned-cart";
export { composeDunning } from "./dunning";
export type { ComposedEmail } from "./receipt";
export { composeOrderReceipt, sendOrderReceipt } from "./receipt";
export { composeRefundReceipt, sendRefundReceipt } from "./refund";
export {
	composeReviewRequest,
	sendReviewRequest,
} from "./review-request";
export {
	composeSubscriptionRenewed,
	sendSubscriptionRenewed,
} from "./subscription-renewed";
export {
	composeVendorActivated,
	composeVendorInvite,
	sendVendorActivated,
	sendVendorInvite,
} from "./vendor-onboarding";
export {
	composeVendorPayout,
	sendVendorPayout,
} from "./vendor-payout";

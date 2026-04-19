/**
 * @deprecated Phase 15 — moved to `src/emails/*`.
 *
 * This module used to contain the only transactional email composition
 * (text-only receipts). Phase 15 consolidated all email code under
 * `src/emails/`, added HTML rendering, and added four new events. This
 * file is now a thin re-export so existing imports from
 * `orders/receipt` keep working — prefer importing from
 * `../emails` directly in new code.
 */

export {
	composeOrderReceipt,
	composeRefundReceipt,
	sendOrderReceipt,
	sendRefundReceipt,
} from "../emails";

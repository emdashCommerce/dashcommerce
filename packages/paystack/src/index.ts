/**
 * @dashcommerce/paystack
 *
 * Paystack PaymentProvider for DashCommerce: hosted checkout (card and
 * M-Pesa via Paystack's `mobile_money` channel), Web Crypto HMAC-SHA512
 * webhook verification, live status checks and refunds.
 *
 * Importing this module registers the provider with core's registry.
 */

import { getPaymentProvider, registerPaymentProvider } from "@dashcommerce/core/payment-provider";
import { paystackPaymentProvider } from "./provider";

export { paystackPaymentProvider, paystackReferenceFor } from "./provider";
export {
	verifyPaystackSignature,
	type VerifyInput,
	type VerifyResult,
} from "./webhook-verify";
export {
	call as callPaystack,
	PaystackApiError,
	PAYSTACK_API_BASE,
	type PaystackClientOptions,
	type PaystackCallOptions,
	type PaystackResponse,
} from "./client";

/**
 * Register the Paystack provider. Safe to call more than once. If a
 * different provider already holds the `paystack` id this throws, unless
 * `{ override: true }` is passed, so a clash is never silent.
 */
export function registerPaystackProvider(opts: { override?: boolean } = {}): void {
	if (
		!opts.override &&
		getPaymentProvider(paystackPaymentProvider.id) === paystackPaymentProvider
	) {
		return;
	}
	registerPaymentProvider(paystackPaymentProvider, opts);
}

registerPaystackProvider();

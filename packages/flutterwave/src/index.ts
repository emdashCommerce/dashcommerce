/**
 * @dashcommerce/flutterwave
 *
 * Flutterwave PaymentProvider for DashCommerce: hosted checkout (card,
 * M-Pesa and mobile money), `verif-hash` webhook verification, live status
 * checks and refunds.
 *
 * Importing this module registers the provider with core's registry.
 */

import { getPaymentProvider, registerPaymentProvider } from "@dashcommerce/core/payment-provider";
import { flutterwavePaymentProvider } from "./provider";

export {
	flutterwavePaymentProvider,
	flutterwaveReferenceFor,
	toMajorUnits,
	toMinorUnits,
} from "./provider";
export {
	verifyFlutterwaveSecretHash,
	type VerifyInput,
	type VerifyResult,
} from "./webhook-verify";
export {
	call as callFlutterwave,
	FlutterwaveApiError,
	FLUTTERWAVE_API_BASE,
	type FlutterwaveClientOptions,
	type FlutterwaveCallOptions,
	type FlutterwaveResponse,
} from "./client";

/**
 * Register the Flutterwave provider. Safe to call more than once. If a
 * different provider already holds the `flutterwave` id this throws, unless
 * `{ override: true }` is passed, so a clash is never silent.
 */
export function registerFlutterwaveProvider(opts: { override?: boolean } = {}): void {
	if (
		!opts.override &&
		getPaymentProvider(flutterwavePaymentProvider.id) === flutterwavePaymentProvider
	) {
		return;
	}
	registerPaymentProvider(flutterwavePaymentProvider, opts);
}

registerFlutterwaveProvider();

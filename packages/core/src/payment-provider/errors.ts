/**
 * Thrown by a provider's `initCheckout` when the provider refuses the cart's
 * currency, for example a Paystack account that isn't enabled for USD.
 * Core answers `create-session` with a 400 the customer can act on, instead
 * of a 500 that suggests trying again.
 *
 * Core recognises it by `code`, not `instanceof`, so a provider package
 * bundled with its own copy of core still works.
 */
export class CurrencyNotSupportedError extends Error {
	readonly code = "currency_not_supported";

	constructor(readonly currency: string) {
		super(`The payment provider does not accept ${currency} for this shop`);
		this.name = "CurrencyNotSupportedError";
	}
}

/** True for a {@link CurrencyNotSupportedError}, from any copy of core. */
export function isCurrencyNotSupportedError(err: unknown): err is CurrencyNotSupportedError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "currency_not_supported" &&
		typeof (err as { currency?: unknown }).currency === "string"
	);
}

/**
 * Money — integer minor units + ISO 4217 currency code.
 *
 * All pricing, cart totals, order totals, refunds, coupons, shipping rates,
 * and tax line items in DashCommerce flow through `Money`. Arithmetic never
 * crosses currencies; attempting to add USD to EUR throws. No floats.
 *
 * For zero-decimal currencies (JPY, KRW, VND, …) the `amount` field is the
 * actual currency value. For everything else it's in cents (or equivalent
 * minor unit — filler, agorot, centavos, …).
 */

export type CurrencyCode = string; // ISO 4217 uppercase 3-letter code

export interface Money {
	currency: CurrencyCode;
	amount: number; // integer minor units
}

/**
 * Currencies that do not use a minor unit — `amount` is the actual value.
 * Source: ISO 4217.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<CurrencyCode> = new Set([
	"BIF",
	"CLP",
	"DJF",
	"GNF",
	"ISK",
	"JPY",
	"KMF",
	"KRW",
	"MGA",
	"PYG",
	"RWF",
	"UGX",
	"VND",
	"VUV",
	"XAF",
	"XOF",
	"XPF",
]);

/**
 * Three-decimal currencies (rarely relevant to consumer commerce).
 * Stripe rounds these to the nearest minor unit on charge.
 */
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<CurrencyCode> = new Set([
	"BHD",
	"IQD",
	"JOD",
	"KWD",
	"LYD",
	"OMR",
	"TND",
]);

export function minorUnitsFactor(currency: CurrencyCode): number {
	const code = currency.toUpperCase();
	if (ZERO_DECIMAL_CURRENCIES.has(code)) return 1;
	if (THREE_DECIMAL_CURRENCIES.has(code)) return 1000;
	return 100;
}

export class CurrencyMismatchError extends Error {
	constructor(a: CurrencyCode, b: CurrencyCode) {
		super(`Currency mismatch: ${a} vs ${b}`);
		this.name = "CurrencyMismatchError";
	}
}

export function money(currency: CurrencyCode, amount: number): Money {
	if (!Number.isInteger(amount)) {
		throw new Error(`Money.amount must be an integer (got ${amount} for ${currency})`);
	}
	return { currency: currency.toUpperCase(), amount };
}

export function zero(currency: CurrencyCode): Money {
	return money(currency, 0);
}

export function isSameCurrency(a: Money, b: Money): boolean {
	return a.currency === b.currency;
}

function assertSameCurrency(a: Money, b: Money): void {
	if (!isSameCurrency(a, b)) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
	assertSameCurrency(a, b);
	return money(a.currency, a.amount + b.amount);
}

export function sub(a: Money, b: Money): Money {
	assertSameCurrency(a, b);
	return money(a.currency, a.amount - b.amount);
}

export function mul(a: Money, factor: number): Money {
	return money(a.currency, Math.round(a.amount * factor));
}

/** Percentage `percent` of `a`, rounded to the nearest minor unit (half-up). */
export function percent(a: Money, percentValue: number): Money {
	return money(a.currency, Math.round((a.amount * percentValue) / 100));
}

/** Sum a list of `Money` values; all must share currency, or the first's currency on empty. */
export function sum(values: ReadonlyArray<Money>, fallbackCurrency?: CurrencyCode): Money {
	if (values.length === 0) {
		if (!fallbackCurrency) throw new Error("sum() requires fallbackCurrency for empty list");
		return zero(fallbackCurrency);
	}
	const first = values[0];
	// We enforce non-undefined via length check; TS needs the help.
	if (!first) throw new Error("unreachable");
	let total = first;
	for (let i = 1; i < values.length; i += 1) {
		const next = values[i];
		if (!next) continue;
		total = add(total, next);
	}
	return total;
}

export function compare(a: Money, b: Money): number {
	assertSameCurrency(a, b);
	return a.amount - b.amount;
}

export function gte(a: Money, b: Money): boolean {
	return compare(a, b) >= 0;
}

export function lte(a: Money, b: Money): boolean {
	return compare(a, b) <= 0;
}

export function isZero(a: Money): boolean {
	return a.amount === 0;
}

export function isNegative(a: Money): boolean {
	return a.amount < 0;
}

/**
 * Format `Money` using Intl.NumberFormat. Runs on server and client. Falls
 * back to a simple currency-prefixed string when Intl is unavailable (e.g.
 * some sandbox runtimes).
 */
export function format(value: Money, locale = "en-US"): string {
	const factor = minorUnitsFactor(value.currency);
	const asDecimal = value.amount / factor;
	try {
		return new Intl.NumberFormat(locale, {
			style: "currency",
			currency: value.currency,
		}).format(asDecimal);
	} catch {
		return `${value.currency} ${asDecimal.toFixed(factor === 1 ? 0 : factor === 1000 ? 3 : 2)}`;
	}
}

/**
 * Parse a user-entered string like "19.99", "1,299.00", or "¥500" into
 * `Money`. Non-digit/separator characters are stripped. Prefer passing the
 * currency explicitly — sniffing symbols is lossy.
 */
export function parse(input: string, currency: CurrencyCode): Money {
	const cleaned = input.replace(/[^\d.,-]/g, "").replace(/,/g, "");
	const asNumber = Number.parseFloat(cleaned);
	if (!Number.isFinite(asNumber)) {
		throw new Error(`Cannot parse money value: ${input}`);
	}
	const factor = minorUnitsFactor(currency);
	return money(currency, Math.round(asNumber * factor));
}

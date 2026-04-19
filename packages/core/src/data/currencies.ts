/**
 * ISO 4217 currency table. Hand-curated set of commercially-relevant codes
 * — not the full registry. Add here as merchants need them. Shared between
 * admin UI (pickers) and storefront (symbol rendering).
 *
 * `decimals` is the standard fractional-unit count; for display/formatting
 * the existing money.ts helpers remain authoritative.
 */
export interface CurrencyInfo {
	code: string;
	name: string;
	symbol: string;
	decimals: 0 | 2 | 3;
}

export const CURRENCY_TABLE: readonly CurrencyInfo[] = [
	{ code: "USD", name: "US Dollar", symbol: "$", decimals: 2 },
	{ code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
	{ code: "GBP", name: "British Pound", symbol: "£", decimals: 2 },
	{ code: "JPY", name: "Japanese Yen", symbol: "¥", decimals: 0 },
	{ code: "CAD", name: "Canadian Dollar", symbol: "CA$", decimals: 2 },
	{ code: "AUD", name: "Australian Dollar", symbol: "A$", decimals: 2 },
	{ code: "NZD", name: "New Zealand Dollar", symbol: "NZ$", decimals: 2 },
	{ code: "CHF", name: "Swiss Franc", symbol: "CHF", decimals: 2 },
	{ code: "SEK", name: "Swedish Krona", symbol: "kr", decimals: 2 },
	{ code: "NOK", name: "Norwegian Krone", symbol: "kr", decimals: 2 },
	{ code: "DKK", name: "Danish Krone", symbol: "kr", decimals: 2 },
	{ code: "PLN", name: "Polish Złoty", symbol: "zł", decimals: 2 },
	{ code: "CZK", name: "Czech Koruna", symbol: "Kč", decimals: 2 },
	{ code: "HUF", name: "Hungarian Forint", symbol: "Ft", decimals: 2 },
	{ code: "RON", name: "Romanian Leu", symbol: "lei", decimals: 2 },
	{ code: "BGN", name: "Bulgarian Lev", symbol: "лв", decimals: 2 },
	{ code: "HRK", name: "Croatian Kuna", symbol: "kn", decimals: 2 },
	{ code: "TRY", name: "Turkish Lira", symbol: "₺", decimals: 2 },
	{ code: "RUB", name: "Russian Ruble", symbol: "₽", decimals: 2 },
	{ code: "UAH", name: "Ukrainian Hryvnia", symbol: "₴", decimals: 2 },
	{ code: "ILS", name: "Israeli Shekel", symbol: "₪", decimals: 2 },
	{ code: "AED", name: "UAE Dirham", symbol: "د.إ", decimals: 2 },
	{ code: "SAR", name: "Saudi Riyal", symbol: "﷼", decimals: 2 },
	{ code: "QAR", name: "Qatari Riyal", symbol: "﷼", decimals: 2 },
	{ code: "KWD", name: "Kuwaiti Dinar", symbol: "د.ك", decimals: 3 },
	{ code: "BHD", name: "Bahraini Dinar", symbol: ".د.ب", decimals: 3 },
	{ code: "OMR", name: "Omani Rial", symbol: "﷼", decimals: 3 },
	{ code: "JOD", name: "Jordanian Dinar", symbol: "د.ا", decimals: 3 },
	{ code: "EGP", name: "Egyptian Pound", symbol: "E£", decimals: 2 },
	{ code: "MAD", name: "Moroccan Dirham", symbol: "د.م.", decimals: 2 },
	{ code: "ZAR", name: "South African Rand", symbol: "R", decimals: 2 },
	{ code: "NGN", name: "Nigerian Naira", symbol: "₦", decimals: 2 },
	{ code: "KES", name: "Kenyan Shilling", symbol: "KSh", decimals: 2 },
	{ code: "GHS", name: "Ghanaian Cedi", symbol: "₵", decimals: 2 },
	{ code: "INR", name: "Indian Rupee", symbol: "₹", decimals: 2 },
	{ code: "PKR", name: "Pakistani Rupee", symbol: "₨", decimals: 2 },
	{ code: "BDT", name: "Bangladeshi Taka", symbol: "৳", decimals: 2 },
	{ code: "LKR", name: "Sri Lankan Rupee", symbol: "Rs", decimals: 2 },
	{ code: "NPR", name: "Nepalese Rupee", symbol: "₨", decimals: 2 },
	{ code: "CNY", name: "Chinese Yuan", symbol: "¥", decimals: 2 },
	{ code: "HKD", name: "Hong Kong Dollar", symbol: "HK$", decimals: 2 },
	{ code: "TWD", name: "Taiwan Dollar", symbol: "NT$", decimals: 2 },
	{ code: "KRW", name: "South Korean Won", symbol: "₩", decimals: 0 },
	{ code: "SGD", name: "Singapore Dollar", symbol: "S$", decimals: 2 },
	{ code: "MYR", name: "Malaysian Ringgit", symbol: "RM", decimals: 2 },
	{ code: "IDR", name: "Indonesian Rupiah", symbol: "Rp", decimals: 2 },
	{ code: "THB", name: "Thai Baht", symbol: "฿", decimals: 2 },
	{ code: "PHP", name: "Philippine Peso", symbol: "₱", decimals: 2 },
	{ code: "VND", name: "Vietnamese Dong", symbol: "₫", decimals: 0 },
	{ code: "MXN", name: "Mexican Peso", symbol: "MX$", decimals: 2 },
	{ code: "BRL", name: "Brazilian Real", symbol: "R$", decimals: 2 },
	{ code: "ARS", name: "Argentine Peso", symbol: "$", decimals: 2 },
	{ code: "CLP", name: "Chilean Peso", symbol: "$", decimals: 0 },
	{ code: "COP", name: "Colombian Peso", symbol: "$", decimals: 2 },
	{ code: "PEN", name: "Peruvian Sol", symbol: "S/.", decimals: 2 },
	{ code: "UYU", name: "Uruguayan Peso", symbol: "$U", decimals: 2 },
	{ code: "BOB", name: "Bolivian Boliviano", symbol: "Bs.", decimals: 2 },
	{ code: "PYG", name: "Paraguayan Guarani", symbol: "₲", decimals: 0 },
	{ code: "ISK", name: "Icelandic Króna", symbol: "kr", decimals: 0 },
];

export const CURRENCY_CODES: readonly string[] = CURRENCY_TABLE.map((c) => c.code);
const CURRENCY_INDEX: Record<string, CurrencyInfo> = Object.fromEntries(
	CURRENCY_TABLE.map((c) => [c.code, c]),
);

export function isValidCurrencyCode(code: unknown): code is string {
	return typeof code === "string" && /^[A-Z]{3}$/.test(code) && code in CURRENCY_INDEX;
}

export function getCurrencyInfo(code: string): CurrencyInfo | undefined {
	return CURRENCY_INDEX[code.toUpperCase()];
}

/**
 * Normalize and dedupe a list of currency codes: uppercase, validate against
 * the ISO-4217 table, drop duplicates and invalid entries. Pure — returns a
 * fresh array.
 */
export function normalizeCurrencyList(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		if (typeof raw !== "string") continue;
		const code = raw.trim().toUpperCase();
		if (!isValidCurrencyCode(code)) continue;
		if (seen.has(code)) continue;
		seen.add(code);
		out.push(code);
	}
	return out;
}

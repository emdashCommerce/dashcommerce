/**
 * Plugin settings, stored through `ctx.settings`. The two Stripe secrets
 * are declared `type: "secret"` in emdash-plugin.jsonc so EmDash encrypts
 * them at rest. Defaults are applied on read so new settings need no
 * migration.
 *
 * Routes read every setting with one `ctx.settings.list()` call (secrets
 * come back decrypted) to keep the number of bridge calls per request low.
 */

import type { PluginContext } from "emdash/plugin";
import { minorUnitsFactor } from "./shared";

export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_SUCCESS_URL = "/checkout/success?order={ORDER_ID}&key={ORDER_KEY}";
export const DEFAULT_CANCEL_URL = "/cart";
/** Upper bound for the flat tax rate, as a typo guard. */
export const MAX_TAX_PERCENT = 50;
/** Upper bound for flat shipping, in major units (for example 10000.00 USD). */
const MAX_SHIPPING_MAJOR = 10_000;

export interface LiteConfig {
	stripeSecretKey: string | null;
	stripeWebhookSecret: string | null;
	currency: string;
	successUrl: string;
	cancelUrl: string;
	shippingCountries: string[];
	/** Flat shipping per order that has a physical item, in minor units. 0 means none. */
	flatShipping: number;
	/** Flat tax on the item subtotal, in percent. 0 means none. */
	flatTaxPercent: number;
	/** Let Stripe Tax add tax on the hosted Checkout page. Excludes flat tax. */
	automaticTax: boolean;
}

export async function loadConfig(ctx: PluginContext): Promise<LiteConfig> {
	const entries = await ctx.settings.list();
	const values = new Map(entries.map((e) => [e.key, e.value]));
	return configFrom((key) => values.get(key));
}

export function configFrom(get: (key: string) => unknown): LiteConfig {
	const str = (key: string) => {
		const v = get(key);
		return typeof v === "string" && v.length > 0 ? v : null;
	};
	const shipping = get("flatShipping");
	return {
		stripeSecretKey: str("stripeSecretKey"),
		stripeWebhookSecret: str("stripeWebhookSecret"),
		currency: normalizeCurrency(get("currency")) ?? DEFAULT_CURRENCY,
		successUrl: str("successUrl") ?? DEFAULT_SUCCESS_URL,
		cancelUrl: str("cancelUrl") ?? DEFAULT_CANCEL_URL,
		shippingCountries: parseCountries(str("shippingCountries") ?? "") ?? [],
		flatShipping:
			typeof shipping === "number" && Number.isInteger(shipping) && shipping > 0 ? shipping : 0,
		flatTaxPercent: parsePercent(get("flatTaxPercent")) ?? 0,
		automaticTax: get("automaticTax") === true,
	};
}

export function normalizeCurrency(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const code = value.trim().toUpperCase();
	return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/** "us, ca ,GB" -> ["US","CA","GB"]; undefined when any entry is invalid. */
export function parseCountries(value: string): string[] | undefined {
	const parts = value
		.split(",")
		.map((p) => p.trim().toUpperCase())
		.filter((p) => p.length > 0);
	if (parts.some((p) => !/^[A-Z]{2}$/.test(p))) return undefined;
	return [...new Set(parts)];
}

function decimalsFor(currency: string): number {
	return Math.round(Math.log10(minorUnitsFactor(currency)));
}

/**
 * "4.99" in USD -> 499. Empty means 0. Undefined for anything else,
 * including more decimals than the currency has.
 */
export function parseAmount(value: unknown, currency: string): number | undefined {
	if (value === undefined || value === null) return 0;
	const s = String(value).trim();
	if (s === "") return 0;
	const m = s.match(/^(\d{1,6})(?:\.(\d{1,3}))?$/);
	if (!m) return undefined;
	const decimals = decimalsFor(currency);
	if ((m[2]?.length ?? 0) > decimals) return undefined;
	const major = Number(s);
	if (major > MAX_SHIPPING_MAJOR) return undefined;
	return Math.round(major * minorUnitsFactor(currency));
}

/** 499 in USD -> "4.99". 0 -> "". */
export function formatAmount(minor: number, currency: string): string {
	if (!minor) return "";
	const decimals = decimalsFor(currency);
	return (minor / minorUnitsFactor(currency)).toFixed(decimals);
}

/** A percent from 0 to MAX_TAX_PERCENT with up to 3 decimals. "" means 0. */
export function parsePercent(value: unknown): number | undefined {
	if (value === undefined || value === null) return 0;
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0 && value <= MAX_TAX_PERCENT ? value : undefined;
	}
	const s = String(value).trim().replace(/%$/, "").trim();
	if (s === "") return 0;
	if (!/^\d{1,2}(\.\d{1,3})?$/.test(s)) return undefined;
	const n = Number(s);
	return n <= MAX_TAX_PERCENT ? n : undefined;
}

/** A site path ("/thanks") or an absolute https URL. */
export function isValidReturnUrl(value: string): boolean {
	if (value.length > 500) return false;
	if (value.startsWith("/") && !value.startsWith("//")) return true;
	return /^https:\/\/[^\s/]+(\/\S*)?$/.test(value);
}

/**
 * Build the absolute URL Stripe redirects to. Template tokens are replaced
 * before joining so the braces in Stripe's own `{CHECKOUT_SESSION_ID}`
 * token survive (the URL constructor would percent-encode them).
 */
export function buildReturnUrl(
	template: string,
	siteUrl: string,
	vars: Record<string, string>,
): string {
	let out = template;
	for (const [k, v] of Object.entries(vars)) {
		out = out.split(`{${k}}`).join(encodeURIComponent(v));
	}
	if (/^https?:\/\//.test(out)) return out;
	return `${siteUrl.replace(/\/+$/, "")}${out.startsWith("/") ? "" : "/"}${out}`;
}

export function isStripeSecretKey(value: string): boolean {
	return /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(value);
}

export function isStripeWebhookSecret(value: string): boolean {
	return /^whsec_[A-Za-z0-9+/=]{8,}$/.test(value);
}

/**
 * Plugin settings, stored through `ctx.settings`. The two Stripe secrets
 * are declared `type: "secret"` in emdash-plugin.jsonc so EmDash encrypts
 * them at rest. Defaults are applied on read so new settings need no
 * migration.
 */

import type { PluginContext } from "emdash/plugin";

export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_SUCCESS_URL = "/checkout/success?order={ORDER_ID}&key={ORDER_KEY}";
export const DEFAULT_CANCEL_URL = "/cart";

export interface LiteSettings {
	currency: string;
	successUrl: string;
	cancelUrl: string;
	shippingCountries: string[];
}

export async function readSettings(ctx: PluginContext): Promise<LiteSettings> {
	const [currency, successUrl, cancelUrl, countries] = await Promise.all([
		ctx.settings.get<string>("currency"),
		ctx.settings.get<string>("successUrl"),
		ctx.settings.get<string>("cancelUrl"),
		ctx.settings.get<string>("shippingCountries"),
	]);
	return {
		currency: normalizeCurrency(currency) ?? DEFAULT_CURRENCY,
		successUrl: successUrl || DEFAULT_SUCCESS_URL,
		cancelUrl: cancelUrl || DEFAULT_CANCEL_URL,
		shippingCountries: parseCountries(countries ?? "") ?? [],
	};
}

export async function readCurrency(ctx: PluginContext): Promise<string> {
	return normalizeCurrency(await ctx.settings.get<string>("currency")) ?? DEFAULT_CURRENCY;
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

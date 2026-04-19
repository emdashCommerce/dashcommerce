/**
 * Settings schema — the authoritative value-shape contract for every key in
 * `settings:*` KV. Used by the admin settings POST route to reject bad
 * writes, and indirectly by the admin form to mirror validation inline.
 *
 * Each validator returns either `{ ok: true, value }` with a coerced value,
 * or `{ ok: false, error }` with a human-readable message. Callers do not
 * need to understand the internal coercion rules — they only check `ok`.
 */

import { isValidCurrencyCode, normalizeCurrencyList } from "../data/currencies";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): Result<T> {
	return { ok: true, value };
}
function bad(error: string): Result<never> {
	return { ok: false, error };
}

function asBool(v: unknown, key: string): Result<boolean> {
	if (typeof v === "boolean") return ok(v);
	return bad(`${key} must be a boolean`);
}

function asInt(v: unknown, key: string, min?: number, max?: number): Result<number> {
	if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
		return bad(`${key} must be an integer`);
	}
	if (min !== undefined && v < min) return bad(`${key} must be ≥ ${min}`);
	if (max !== undefined && v > max) return bad(`${key} must be ≤ ${max}`);
	return ok(v);
}

function asNumber(v: unknown, key: string, min?: number, max?: number): Result<number> {
	if (typeof v !== "number" || !Number.isFinite(v)) {
		return bad(`${key} must be a number`);
	}
	if (min !== undefined && v < min) return bad(`${key} must be ≥ ${min}`);
	if (max !== undefined && v > max) return bad(`${key} must be ≤ ${max}`);
	return ok(v);
}

function asPercent(v: unknown, key: string): Result<number> {
	return asNumber(v, key, 0, 100);
}

function asStringWithPrefix(
	v: unknown,
	key: string,
	prefixes: string[],
): Result<string> {
	if (typeof v !== "string" || v.trim() === "") {
		return bad(`${key} must be a non-empty string`);
	}
	const s = v.trim();
	if (!prefixes.some((p) => s.startsWith(p))) {
		return bad(`${key} must start with one of: ${prefixes.join(", ")}`);
	}
	return ok(s);
}

export const SETTINGS_KEYS = [
	"defaultCurrency",
	"enabledCurrencies",
	"taxMode",
	"flatTaxRatePercent",
	"taxAppliesToShipping",
	"reviewsRequireApproval",
	"reviewsRequirePurchase",
	"downloadTokenTtlHours",
	"downloadMaxUses",
	"downloadGrantExpiryDays",
	"abandonedCartDelayHours",
	"abandonedCartTokenTtlDays",
	"connectEnabled",
	"connectPlatformFeePercent",
	"stripeSecretKey",
	"stripePublishableKey",
	"stripeWebhookSecret",
	"checkoutMode",
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export const SECRET_SETTINGS_KEYS: ReadonlySet<string> = new Set<string>([
	"stripeSecretKey",
	"stripeWebhookSecret",
]);

/** Sentinel the admin form writes when a secret is left untouched. */
export const MASKED_SECRET_PREFIX = "••••";

export const TAX_MODES = ["flat", "table", "stripe_tax"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

/**
 * `hosted`   — redirect to Stripe's hosted Checkout page (SAQ-A, default).
 * `embedded` — use Stripe Elements in the storefront (SAQ-A EP). Legacy.
 *
 * Default is `hosted` for any site that doesn't explicitly set this, which
 * means upgrading DashCommerce *will* flip the checkout flow on existing
 * sites. The trade-off is worth it: lower PCI scope, less UI to maintain,
 * better mobile UX. Merchants who need the embedded flow for custom
 * branding reasons can opt in.
 */
export const CHECKOUT_MODES = ["hosted", "embedded"] as const;
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];
export const DEFAULT_CHECKOUT_MODE: CheckoutMode = "hosted";

/**
 * Validate a single settings key/value pair. Callers that need cross-key
 * checks (e.g. defaultCurrency ∈ enabledCurrencies) use `validateSettings`
 * below.
 */
export function validateSettingsKey(
	key: string,
	value: unknown,
): Result<unknown> {
	switch (key as SettingsKey) {
		case "defaultCurrency": {
			if (typeof value !== "string") return bad("defaultCurrency must be a string");
			const code = value.toUpperCase();
			if (!isValidCurrencyCode(code)) {
				return bad(`defaultCurrency ${value} is not a valid ISO-4217 code`);
			}
			return ok(code);
		}
		case "enabledCurrencies": {
			if (!Array.isArray(value)) return bad("enabledCurrencies must be an array");
			const codes = normalizeCurrencyList(value);
			if (codes.length !== value.length) {
				return bad(
					"enabledCurrencies contains duplicates or invalid ISO-4217 codes",
				);
			}
			if (codes.length === 0) return bad("enabledCurrencies cannot be empty");
			return ok(codes);
		}
		case "taxMode": {
			if (typeof value !== "string" || !TAX_MODES.includes(value as TaxMode)) {
				return bad(`taxMode must be one of: ${TAX_MODES.join(", ")}`);
			}
			return ok(value);
		}
		case "flatTaxRatePercent":
		case "connectPlatformFeePercent":
			return asPercent(value, key);
		case "taxAppliesToShipping":
		case "reviewsRequireApproval":
		case "reviewsRequirePurchase":
		case "connectEnabled":
			return asBool(value, key);
		case "downloadTokenTtlHours":
			return asInt(value, key, 1, 24 * 365);
		case "downloadMaxUses":
			return asInt(value, key, 1, 10_000);
		case "downloadGrantExpiryDays":
			return asInt(value, key, 1, 10 * 365);
		case "abandonedCartDelayHours":
			return asInt(value, key, 1, 24 * 30);
		case "abandonedCartTokenTtlDays":
			return asInt(value, key, 1, 365);
		case "stripeSecretKey":
			return asStringWithPrefix(value, key, ["sk_test_", "sk_live_", "rk_test_", "rk_live_"]);
		case "stripePublishableKey":
			return asStringWithPrefix(value, key, ["pk_test_", "pk_live_"]);
		case "stripeWebhookSecret":
			return asStringWithPrefix(value, key, ["whsec_"]);
		case "checkoutMode": {
			if (typeof value !== "string" || !CHECKOUT_MODES.includes(value as CheckoutMode)) {
				return bad(`checkoutMode must be one of: ${CHECKOUT_MODES.join(", ")}`);
			}
			return ok(value);
		}
		default:
			return bad(`Unknown settings key: ${key}`);
	}
}

export interface SettingsValidationReport {
	ok: boolean;
	values: Record<string, unknown>;
	errors: Record<string, string>;
}

/**
 * Validate and coerce a partial settings payload. Cross-field checks are
 * applied after per-key validation so that consumers see precise messages.
 * Pass `context.currentEnabledCurrencies` to enforce `defaultCurrency ∈
 * enabledCurrencies` when enabledCurrencies is not being changed in the
 * same patch.
 */
export function validateSettings(
	patch: Record<string, unknown>,
	context: { currentEnabledCurrencies?: unknown } = {},
): SettingsValidationReport {
	const values: Record<string, unknown> = {};
	const errors: Record<string, string> = {};

	for (const [k, v] of Object.entries(patch)) {
		if (!SETTINGS_KEYS.includes(k as SettingsKey)) {
			errors[k] = `Unknown settings key: ${k}`;
			continue;
		}
		if (
			SECRET_SETTINGS_KEYS.has(k) &&
			typeof v === "string" &&
			v.startsWith(MASKED_SECRET_PREFIX)
		) {
			// Untouched mask: silently drop from payload so the secret is preserved.
			continue;
		}
		const res = validateSettingsKey(k, v);
		if (res.ok) values[k] = res.value;
		else errors[k] = res.error;
	}

	const nextCurrencies =
		"enabledCurrencies" in values
			? (values.enabledCurrencies as string[])
			: Array.isArray(context.currentEnabledCurrencies)
				? normalizeCurrencyList(context.currentEnabledCurrencies)
				: undefined;

	if ("defaultCurrency" in values && nextCurrencies) {
		const def = values.defaultCurrency as string;
		if (nextCurrencies.length > 0 && !nextCurrencies.includes(def)) {
			errors.defaultCurrency = `defaultCurrency ${def} must be one of enabledCurrencies: ${nextCurrencies.join(", ")}`;
		}
	}

	return { ok: Object.keys(errors).length === 0, values, errors };
}

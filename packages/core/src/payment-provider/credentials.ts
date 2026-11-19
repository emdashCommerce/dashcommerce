/**
 * Load PaymentProvider credentials from plugin KV.
 *
 * Stripe keeps the existing key names (`settings:stripeSecretKey` /
 * `settings:stripeWebhookSecret`). Other providers use
 * `settings:<id>SecretKey` and `settings:<id>WebhookSecret`.
 */

import { getPaymentProvider } from "./registry";
import type { PaymentProviderCredentialField, PaymentProviderCredentials } from "./types";

export interface KvLike {
	get<T>(key: string): Promise<T | null>;
}

export async function loadPaymentProviderCredentials(
	kv: KvLike,
	providerId: string,
): Promise<PaymentProviderCredentials | null> {
	if (providerId === "stripe") {
		const secretKey = await kv.get<string>("settings:stripeSecretKey");
		if (!secretKey) return null;
		const webhookSecret = (await kv.get<string>("settings:stripeWebhookSecret")) ?? undefined;
		return { secretKey, webhookSecret };
	}
	const secretKey = await kv.get<string>(`settings:${providerId}SecretKey`);
	if (!secretKey) return null;
	const webhookSecret = (await kv.get<string>(`settings:${providerId}WebhookSecret`)) ?? undefined;
	return { secretKey, webhookSecret };
}

export function webhookSignatureHeader(headers: Headers, providerId: string): string | null {
	if (providerId === "stripe") {
		return headers.get("stripe-signature");
	}
	return (
		headers.get(`x-${providerId}-signature`) ??
		headers.get("x-webhook-signature") ??
		headers.get("signature")
	);
}

export type ProviderCredentialName = "secretKey" | "webhookSecret";

export interface ProviderCredentialSetting {
	providerId: string;
	field: ProviderCredentialName;
	spec: PaymentProviderCredentialField;
}

const PROVIDER_CREDENTIAL_KEY = /^([a-z][a-z0-9_-]{0,63})(SecretKey|WebhookSecret)$/;

/**
 * If `key` (without the `settings:` prefix) is a credential setting of a
 * registered provider other than Stripe, describe it. Stripe's keys stay
 * in the fixed settings schema.
 */
export function providerCredentialSetting(key: string): ProviderCredentialSetting | undefined {
	const match = PROVIDER_CREDENTIAL_KEY.exec(key);
	const providerId = match?.[1];
	if (!match || !providerId || providerId === "stripe") return undefined;
	const provider = getPaymentProvider(providerId);
	if (!provider) return undefined;
	const field: ProviderCredentialName = match[2] === "SecretKey" ? "secretKey" : "webhookSecret";
	return { providerId, field, spec: provider.credentialFields?.[field] ?? {} };
}

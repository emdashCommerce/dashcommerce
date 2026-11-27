/**
 * Load PaymentProvider credentials from plugin KV.
 *
 * Stripe keeps the existing key names (`settings:stripeSecretKey` /
 * `settings:stripeWebhookSecret`). Other providers use
 * `settings:<id>SecretKey`, `settings:<id>WebhookSecret` and, when they
 * declare one, `settings:<id>PublicKey`.
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
	const publicKey = (await kv.get<string>(`settings:${providerId}PublicKey`)) ?? undefined;
	return {
		secretKey,
		...(webhookSecret ? { webhookSecret } : {}),
		...(publicKey ? { publicKey } : {}),
	};
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

export type ProviderCredentialName = "secretKey" | "webhookSecret" | "publicKey";

export interface ProviderCredentialSetting {
	providerId: string;
	field: ProviderCredentialName;
	spec: PaymentProviderCredentialField;
}

const PROVIDER_CREDENTIAL_KEY = /^([a-z][a-z0-9_-]{0,63})(SecretKey|WebhookSecret|PublicKey)$/;

const CREDENTIAL_FIELD: Record<string, ProviderCredentialName> = {
	SecretKey: "secretKey",
	WebhookSecret: "webhookSecret",
	PublicKey: "publicKey",
};

/**
 * If `key` (without the `settings:` prefix) is a credential setting of a
 * registered provider other than Stripe, describe it. Stripe's keys stay
 * in the fixed settings schema.
 */
export function providerCredentialSetting(key: string): ProviderCredentialSetting | undefined {
	const match = PROVIDER_CREDENTIAL_KEY.exec(key);
	const providerId = match?.[1];
	const suffix = match?.[2];
	if (!match || !providerId || !suffix || providerId === "stripe") return undefined;
	const provider = getPaymentProvider(providerId);
	if (!provider) return undefined;
	const field = CREDENTIAL_FIELD[suffix];
	if (!field) return undefined;
	// Secret key and webhook secret are offered for every provider (Settings
	// falls back to a generic label). A public key is only meaningful when the
	// provider declares one, so don't accept one for a provider that doesn't.
	if (field === "publicKey" && !provider.credentialFields?.publicKey) return undefined;
	return { providerId, field, spec: provider.credentialFields?.[field] ?? {} };
}

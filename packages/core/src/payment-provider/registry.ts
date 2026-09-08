/**
 * Provider registry + runtime selection. `routes/checkout.ts` and
 * `routes/webhook.ts` call `resolveProvider(ctx)` instead of importing
 * `../stripe/*` directly — that one seam is the entire fork.
 *
 * Selection is by `settings:paymentProvider` (plugin KV), defaulting to
 * "stripe" for backwards compatibility with any existing upstream
 * install. Site operators switch it via the plugin's settings admin
 * page (or directly via KV during test-mode bring-up).
 */

import type { PaymentProvider } from "./types";
import { stripePaymentProvider } from "./stripe-provider";

export type PaymentProviderId = "stripe" | "paystack" | "mock";

const registry = new Map<string, PaymentProvider>();
registry.set("stripe", stripePaymentProvider);

/** Sibling packages (e.g. a gateway package (e.g. Paystack)) register
 * themselves here at import time so this fork's core never needs a
 * hard dependency on every gateway package that exists. */
export function registerPaymentProvider(provider: PaymentProvider): void {
	registry.set(provider.id, provider);
}

export function getPaymentProvider(id: string): PaymentProvider | undefined {
	return registry.get(id);
}

export function listPaymentProviders(): PaymentProvider[] {
	return Array.from(registry.values());
}

interface KVLike {
	get<T>(key: string): Promise<T | null>;
}

const DEFAULT_PROVIDER_ID: PaymentProviderId = "stripe";

/** Resolve the active provider for this deployment from plugin KV. Falls
 * back to "stripe" (upstream's only option) if unset, and throws a clear
 * error if the configured id was never registered (e.g. paystack package
 * not imported into astro.config.mjs) rather than silently no-op-ing. */
export async function resolveProvider(kv: KVLike): Promise<PaymentProvider> {
	const configured = (await kv.get<string>("settings:paymentProvider")) ?? DEFAULT_PROVIDER_ID;
	const provider = registry.get(configured);
	if (!provider) {
		throw new Error(
			`dashcommerce: settings:paymentProvider is "${configured}" but no PaymentProvider with that id is registered. ` +
				`Registered: ${Array.from(registry.keys()).join(", ") || "(none)"}.`,
		);
	}
	return provider;
}

// registry.test.ts — plain node:test, same convention as
// emdash-sports/emdash-roles. Run with: npx tsx --test src/**/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	registerPaymentProvider,
	getPaymentProvider,
	listPaymentProviders,
	resolveProvider,
} from "./registry";
import { createMockPaymentProvider } from "./mock-provider";
import { stripePaymentProvider } from "./stripe-provider";

class FakeKV {
	constructor(private store: Record<string, unknown> = {}) {}
	async get<T>(key: string): Promise<T | null> {
		return (this.store[key] as T) ?? null;
	}
}

test("registry: stripe is registered by default", () => {
	assert.ok(getPaymentProvider("stripe"));
	assert.equal(getPaymentProvider("stripe")?.label, "Stripe");
});

test("registry: registerPaymentProvider adds a new provider without clobbering existing ones", () => {
	const before = listPaymentProviders().length;
	registerPaymentProvider(createMockPaymentProvider());
	assert.ok(getPaymentProvider("mock"));
	assert.ok(listPaymentProviders().length >= before);
	assert.ok(getPaymentProvider("stripe"), "registering mock must not remove stripe");
});

test("resolveProvider: defaults to stripe when settings:paymentProvider unset", async () => {
	const kv = new FakeKV();
	const provider = await resolveProvider(kv);
	assert.equal(provider.id, "stripe");
});

test("resolveProvider: honours settings:paymentProvider when set to a registered id", async () => {
	registerPaymentProvider(createMockPaymentProvider());
	const kv = new FakeKV({ "settings:paymentProvider": "mock" });
	const provider = await resolveProvider(kv);
	assert.equal(provider.id, "mock");
});

test("resolveProvider: throws a clear error for an unregistered provider id (never silently no-ops)", async () => {
	const kv = new FakeKV({ "settings:paymentProvider": "flutterwave" });
	await assert.rejects(() => resolveProvider(kv), /flutterwave/);
});

test("stripePaymentProvider: identity + currency policy", () => {
	assert.equal(stripePaymentProvider.id, "stripe");
	assert.deepEqual(stripePaymentProvider.supportedCurrencies(), ["*"]);
});

test("stripePaymentProvider: formatAmount renders major units with currency code", () => {
	assert.equal(
		stripePaymentProvider.formatAmount({ amount: 150000, currency: "kes" }),
		"KES 1500.00",
	);
});

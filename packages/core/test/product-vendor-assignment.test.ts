import { afterEach, describe, expect, it } from "bun:test";
import type { ContentHookEvent, PluginContext } from "emdash";
import { productBeforeSave } from "../src/hooks/content";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import type { Vendor } from "../src/types";

afterEach(() => resetPaymentProviders());

function splitsProvider() {
	return {
		...createMockPaymentProvider({ id: "flw" }),
		label: "Flutterwave",
		capabilities: { splits: true },
	};
}

function vendor(overrides: Partial<Vendor> = {}): Vendor {
	return {
		id: "v1",
		name: "Vendor One",
		email: "v1@example.com",
		onboardingStatus: "active",
		platformFeePercent: 0,
		detailsSubmitted: false,
		chargesEnabled: false,
		payoutsEnabled: false,
		paymentAccounts: {
			flw: {
				accountReference: "RS_V1",
				status: "active",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		},
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function ctxWith(record: Vendor | null, connectEnabled = false): PluginContext {
	return {
		kv: {
			async get<T>(key: string): Promise<T | null> {
				if (key === "settings:connectEnabled") return connectEnabled as T;
				if (key === "settings:defaultCurrency") return "KES" as T;
				return null;
			},
		},
		storage: {
			vendors: {
				async get(id: string) {
					return id === record?.id ? record : null;
				},
			},
		},
	} as unknown as PluginContext;
}

function productEvent(vendorId: string): ContentHookEvent {
	return {
		collection: "products",
		content: {
			data: {
				title: "Matchday ticket",
				type: "simple",
				prices: { KES: { amount: 100_000 } },
				sku: "TICKET-1",
				vendorId,
			},
		},
	} as unknown as ContentHookEvent;
}

describe("assigning a product to a vendor", () => {
	it("accepts a Flutterwave vendor without Stripe Connect", async () => {
		registerPaymentProvider(splitsProvider());
		await expect(productBeforeSave(productEvent("v1"), ctxWith(vendor()))).resolves.toBeUndefined();
	});

	it("rejects a vendor with no active payout account", async () => {
		registerPaymentProvider(splitsProvider());
		await expect(
			productBeforeSave(productEvent("v1"), ctxWith(vendor({ paymentAccounts: {} }))),
		).rejects.toThrow(/no active payout account/);
	});

	it("rejects any vendor when no marketplace is enabled", async () => {
		await expect(productBeforeSave(productEvent("v1"), ctxWith(vendor()))).rejects.toThrow(
			/multi-vendor marketplace is disabled/,
		);
	});

	it("still accepts a Stripe vendor when Connect is on", async () => {
		await expect(
			productBeforeSave(
				productEvent("v1"),
				ctxWith(vendor({ stripeAccountId: "acct_1", chargesEnabled: true }), true),
			),
		).resolves.toBeUndefined();
	});

	it("accepts an unassigned product in either mode", async () => {
		await expect(productBeforeSave(productEvent(""), ctxWith(null))).resolves.toBeUndefined();
	});
});

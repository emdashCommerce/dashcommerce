import { describe, expect, it } from "bun:test";
import { money, zero } from "../src/money";
import type { CartLineItem, CartState, Vendor } from "../src/types";
import { computeProviderSplit } from "../src/vendors/provider-split";

/** Tiny stub of ctx exposing `kv` + a vendors storage collection. */
function stubCtx(opts: { vendors?: Record<string, Vendor>; globalFee?: number }) {
	const vendorMap = new Map(Object.entries(opts.vendors ?? {}));
	const kvStore = new Map<string, unknown>();
	if (opts.globalFee !== undefined)
		kvStore.set("settings:connectPlatformFeePercent", opts.globalFee);

	return {
		kv: {
			async get<T>(key: string): Promise<T | null> {
				return (kvStore.get(key) as T | undefined) ?? null;
			},
		},
		storage: {
			vendors: {
				async get(id: string): Promise<Vendor | null> {
					return vendorMap.get(id) ?? null;
				},
			},
		},
	} as unknown as import("emdash").PluginContext;
}

function line(productId: string, unit: number, vendorId?: string): CartLineItem {
	return {
		lineId: `l-${productId}`,
		productId,
		quantity: 1,
		unitPrice: money("KES", unit),
		lineSubtotal: money("KES", unit),
		title: productId,
		isDigital: false,
		...(vendorId ? { vendorId } : {}),
	};
}

function cart(
	items: CartLineItem[],
	opts: { tax?: number; shipping?: number; total?: number } = {},
): CartState {
	const subtotal = items.reduce((sum, item) => sum + item.lineSubtotal.amount, 0);
	const tax = opts.tax ?? 0;
	const shipping = opts.shipping ?? 0;
	return {
		sessionId: "sess",
		currency: "KES",
		items,
		coupons: [],
		taxLines: [],
		subtotal: money("KES", subtotal),
		discountTotal: zero("KES"),
		shippingTotal: money("KES", shipping),
		taxTotal: money("KES", tax),
		total: money("KES", opts.total ?? subtotal + tax + shipping),
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	} as unknown as CartState;
}

function vendor(id: string, overrides: Partial<Vendor> = {}): Vendor {
	return {
		id,
		stripeAccountId: "",
		name: `Vendor ${id}`,
		email: `${id}@example.com`,
		onboardingStatus: "active",
		platformFeePercent: 0,
		detailsSubmitted: false,
		chargesEnabled: false,
		payoutsEnabled: false,
		paymentAccounts: {
			flutterwave: {
				accountReference: `RS_${id.toUpperCase()}`,
				status: "active",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		},
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("computeProviderSplit", () => {
	it("returns no allocations and the whole total for a platform-only cart", async () => {
		const ctx = stubCtx({ globalFee: 10 });
		const plan = await computeProviderSplit(ctx, cart([line("a", 10_000)]), "flutterwave");
		expect(plan.allocations).toEqual([]);
		expect(plan.platformRemainderMinor).toBe(10_000);
	});

	it("gives one vendor its line subtotal minus the global fee", async () => {
		const ctx = stubCtx({ vendors: { v1: vendor("v1") }, globalFee: 10 });
		const plan = await computeProviderSplit(ctx, cart([line("a", 10_000, "v1")]), "flutterwave");
		expect(plan.allocations).toEqual([
			{ vendorId: "v1", accountReference: "RS_V1", amountMinor: 9_000 },
		]);
		// The 10% platform fee is part of the remainder.
		expect(plan.platformRemainderMinor).toBe(1_000);
	});

	it("splits across multiple vendors", async () => {
		const ctx = stubCtx({
			vendors: { v1: vendor("v1"), v2: vendor("v2") },
			globalFee: 10,
		});
		const plan = await computeProviderSplit(
			ctx,
			cart([line("a", 10_000, "v1"), line("b", 5_000, "v2")]),
			"flutterwave",
		);
		expect(plan.allocations).toEqual([
			{ vendorId: "v1", accountReference: "RS_V1", amountMinor: 9_000 },
			{ vendorId: "v2", accountReference: "RS_V2", amountMinor: 4_500 },
		]);
		expect(plan.platformRemainderMinor).toBe(1_500);
	});

	it("keeps tax, shipping and platform items in the remainder", async () => {
		const ctx = stubCtx({ vendors: { v1: vendor("v1") }, globalFee: 10 });
		const plan = await computeProviderSplit(
			ctx,
			cart([line("a", 10_000, "v1"), line("platform", 2_000)], {
				tax: 500,
				shipping: 1_000,
			}),
			"flutterwave",
		);
		expect(plan.allocations[0]?.amountMinor).toBe(9_000);
		// total 13_500 - 9_000
		expect(plan.platformRemainderMinor).toBe(4_500);
	});

	it("uses a vendor's fee override", async () => {
		const ctx = stubCtx({
			vendors: { v1: vendor("v1", { platformFeePercent: 25 }) },
			globalFee: 10,
		});
		const plan = await computeProviderSplit(ctx, cart([line("a", 10_000, "v1")]), "flutterwave");
		expect(plan.allocations[0]?.amountMinor).toBe(7_500);
	});

	it("throws when the vendor has no account for this provider", async () => {
		const ctx = stubCtx({ vendors: { v1: vendor("v1", { paymentAccounts: {} }) }, globalFee: 10 });
		await expect(
			computeProviderSplit(ctx, cart([line("a", 10_000, "v1")]), "flutterwave"),
		).rejects.toThrow(/has no flutterwave payout account/);
	});

	it("throws when the account is not active", async () => {
		const ctx = stubCtx({
			vendors: {
				v1: vendor("v1", {
					paymentAccounts: {
						flutterwave: {
							accountReference: "RS_V1",
							status: "pending",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					},
				}),
			},
			globalFee: 10,
		});
		await expect(
			computeProviderSplit(ctx, cart([line("a", 10_000, "v1")]), "flutterwave"),
		).rejects.toThrow(/is pending, not active/);
	});

	it("throws when the account settles in another currency", async () => {
		const ctx = stubCtx({
			vendors: {
				v1: vendor("v1", {
					paymentAccounts: {
						flutterwave: {
							accountReference: "RS_V1",
							status: "active",
							currency: "NGN",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					},
				}),
			},
			globalFee: 10,
		});
		await expect(
			computeProviderSplit(ctx, cart([line("a", 10_000, "v1")]), "flutterwave"),
		).rejects.toThrow(/settles in NGN, but the cart is in KES/);
	});

	it("throws when the vendor no longer exists", async () => {
		const ctx = stubCtx({ globalFee: 10 });
		await expect(
			computeProviderSplit(ctx, cart([line("a", 10_000, "ghost")]), "flutterwave"),
		).rejects.toThrow(/was not found/);
	});

	it("throws when the fee leaves the vendor nothing", async () => {
		const ctx = stubCtx({
			vendors: { v1: vendor("v1", { platformFeePercent: 100 }) },
			globalFee: 10,
		});
		await expect(
			computeProviderSplit(ctx, cart([line("a", 10_000, "v1")]), "flutterwave"),
		).rejects.toThrow(/share must be positive/);
	});

	it("refuses allocations that do not fit inside the cart total", async () => {
		const ctx = stubCtx({ vendors: { v1: vendor("v1") }, globalFee: 0 });
		// A corrupt cart whose total is lower than its line subtotals.
		await expect(
			computeProviderSplit(ctx, cart([line("a", 10_000, "v1")], { total: 5_000 }), "flutterwave"),
		).rejects.toThrow(/exceed the cart total/);
	});
});

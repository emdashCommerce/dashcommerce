import { describe, expect, it } from "bun:test";
import { computeSplit, connectEnabled } from "../src/vendors/split";
import { money, zero } from "../src/money";
import type { CartLineItem, CartState, Vendor } from "../src/types";

/** Tiny stub of ctx exposing `kv` + a vendors storage collection. */
function stubCtx(opts: {
	vendors?: Record<string, Vendor>;
	connectEnabled?: boolean;
	globalFee?: number;
}) {
	const vendorMap = new Map(Object.entries(opts.vendors ?? {}));
	const kvStore = new Map<string, unknown>();
	if (opts.connectEnabled !== undefined) kvStore.set("settings:connectEnabled", opts.connectEnabled);
	if (opts.globalFee !== undefined) kvStore.set("settings:connectPlatformFeePercent", opts.globalFee);

	const ctx = {
		kv: {
			async get<T>(key: string): Promise<T | null> {
				return (kvStore.get(key) as T | undefined) ?? null;
			},
			async set(key: string, value: unknown) {
				kvStore.set(key, value);
			},
			async delete(key: string) {
				return kvStore.delete(key);
			},
			async list() {
				return [];
			},
		},
		storage: {
			vendors: {
				async get(id: string): Promise<Vendor | null> {
					return vendorMap.get(id) ?? null;
				},
				async query(opts: { where?: { stripeAccountId?: string } }) {
					if (opts.where?.stripeAccountId) {
						const hits = [...vendorMap.values()].filter(
							(v) => v.stripeAccountId === opts.where?.stripeAccountId,
						);
						return { items: hits.map((v) => ({ id: v.id, data: v })), hasMore: false };
					}
					return { items: [], hasMore: false };
				},
			},
		},
	} as unknown as import("emdash").PluginContext;
	return ctx;
}

function line(productId: string, unit: number, vendorId?: string): CartLineItem {
	return {
		lineId: `l-${productId}`,
		productId,
		quantity: 1,
		unitPrice: money("USD", unit),
		lineSubtotal: money("USD", unit),
		title: productId,
		isDigital: false,
		...(vendorId ? { vendorId } : {}),
	};
}

function cart(items: CartLineItem[]): CartState {
	const subtotal = items.reduce((s, i) => s + i.lineSubtotal.amount, 0);
	return {
		sessionId: "sess",
		currency: "USD",
		items,
		coupons: [],
		taxLines: [],
		subtotal: money("USD", subtotal),
		discountTotal: zero("USD"),
		shippingTotal: zero("USD"),
		taxTotal: zero("USD"),
		total: money("USD", subtotal),
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function vendor(id: string, overrides: Partial<Vendor> = {}): Vendor {
	return {
		id,
		stripeAccountId: `acct_${id}`,
		name: `Vendor ${id}`,
		email: `${id}@example.com`,
		onboardingStatus: "active",
		platformFeePercent: 0,
		detailsSubmitted: true,
		chargesEnabled: true,
		payoutsEnabled: true,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("connectEnabled", () => {
	it("defaults to false", async () => {
		const ctx = stubCtx({});
		expect(await connectEnabled(ctx)).toBe(false);
	});

	it("reflects the KV setting", async () => {
		const ctx = stubCtx({ connectEnabled: true });
		expect(await connectEnabled(ctx)).toBe(true);
	});
});

describe("computeSplit", () => {
	it("mode=platform when no vendor items", async () => {
		const ctx = stubCtx({ globalFee: 10 });
		const plan = await computeSplit(ctx, cart([line("a", 10_000)]));
		expect(plan.mode).toBe("platform");
		expect(plan.vendorGroups.length).toBe(0);
	});

	it("mode=single-vendor with destination + fee from global default", async () => {
		const ctx = stubCtx({
			vendors: { v1: vendor("v1") },
			globalFee: 10,
		});
		const plan = await computeSplit(ctx, cart([line("a", 10_000, "v1")]));
		expect(plan.mode).toBe("single-vendor");
		expect(plan.vendorGroups).toHaveLength(1);
		const g = plan.vendorGroups[0];
		expect(g?.stripeAccountId).toBe("acct_v1");
		expect(g?.applicationFee.amount).toBe(1_000); // 10% of 10_000
		expect(g?.vendorAmount.amount).toBe(9_000);
	});

	it("per-vendor platformFeePercent overrides global default", async () => {
		const ctx = stubCtx({
			vendors: { v1: vendor("v1", { platformFeePercent: 25 }) },
			globalFee: 10,
		});
		const plan = await computeSplit(ctx, cart([line("a", 10_000, "v1")]));
		expect(plan.vendorGroups[0]?.applicationFee.amount).toBe(2_500);
	});

	it("mode=multi-vendor with one group per vendor", async () => {
		const ctx = stubCtx({
			vendors: {
				v1: vendor("v1"),
				v2: vendor("v2"),
			},
			globalFee: 10,
		});
		const plan = await computeSplit(
			ctx,
			cart([line("a", 10_000, "v1"), line("b", 5_000, "v2")]),
		);
		expect(plan.mode).toBe("multi-vendor");
		expect(plan.vendorGroups).toHaveLength(2);
	});

	it("mode=multi-vendor when cart mixes platform + vendor items", async () => {
		const ctx = stubCtx({
			vendors: { v1: vendor("v1") },
			globalFee: 10,
		});
		const plan = await computeSplit(
			ctx,
			cart([line("a", 10_000, "v1"), line("p", 500)]),
		);
		expect(plan.mode).toBe("multi-vendor");
		expect(plan.platformGroup?.subtotal.amount).toBe(500);
	});

	it("throws when cart references a missing vendor", async () => {
		const ctx = stubCtx({ globalFee: 10 });
		await expect(
			computeSplit(ctx, cart([line("a", 10_000, "ghost")])),
		).rejects.toThrow(/ghost/);
	});

	it("throws when a vendor has chargesEnabled=false", async () => {
		const ctx = stubCtx({
			vendors: { v1: vendor("v1", { chargesEnabled: false }) },
			globalFee: 10,
		});
		await expect(
			computeSplit(ctx, cart([line("a", 10_000, "v1")])),
		).rejects.toThrow(/cannot accept charges/);
	});
});

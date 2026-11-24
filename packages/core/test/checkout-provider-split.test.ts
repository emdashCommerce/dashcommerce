import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { money, zero } from "../src/money";
import {
	type InitCheckoutInput,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import type { CartLineItem, CartState, Vendor } from "../src/types";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

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
			flw: {
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

function line(id: string, vendorId?: string): CartLineItem {
	const kes = (amount: number) => money("KES", amount);
	return {
		lineId: id,
		productId: "prod_ticket",
		quantity: 1,
		title: "Matchday ticket",
		isDigital: true,
		unitPrice: kes(150_000),
		lineSubtotal: kes(150_000),
		...(vendorId ? { vendorId } : {}),
	};
}

function splitCart(sessionId: string): CartState {
	const kes = (amount: number) => money("KES", amount);
	const items = [line("l1", "v1"), line("l2", "v2"), line("l3")];
	const subtotal = items.reduce((sum, item) => sum + item.lineSubtotal.amount, 0);
	return {
		sessionId,
		currency: "KES",
		customerEmail: "supporter@example.com",
		billingAddress: { line1: "Ngong Road", city: "Nairobi", country: "KE" },
		shippingAddress: { line1: "Ngong Road", city: "Nairobi", country: "KE" },
		items,
		coupons: [],
		taxLines: [],
		subtotal: kes(subtotal),
		discountTotal: zero("KES"),
		shippingTotal: zero("KES"),
		taxTotal: zero("KES"),
		total: kes(subtotal),
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	} as unknown as CartState;
}

function recordingProvider(options: Parameters<typeof createMockPaymentProvider>[0] = {}) {
	const seen: InitCheckoutInput[] = [];
	const base = createMockPaymentProvider({ id: "flw", ...options });
	const provider = {
		...base,
		async initCheckout(
			ctx: Parameters<typeof base.initCheckout>[0],
			input: InitCheckoutInput,
			creds: Parameters<typeof base.initCheckout>[2],
		) {
			seen.push(input);
			return base.initCheckout(ctx, input, creds);
		},
	};
	return { provider, seen };
}

async function startCheckout(
	ctx: PluginContext,
	sessionId: string,
	cart: CartState,
): Promise<Response> {
	await ctx.kv.set(`cart:${sessionId}`, cart);
	const request = new Request("http://test/checkout/create-session", {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: `dashcommerce_sid=${sessionId}` },
		body: JSON.stringify({ customerEmail: "supporter@example.com" }),
	});
	const routeCtx = {
		...ctx,
		request,
		input: { customerEmail: "supporter@example.com" },
	} as unknown as RouteContext;
	return (await sandbox.routes["checkout/create-session"].handler(routeCtx, ctx)) as Response;
}

const settings = {
	"settings:paymentProvider": "flw",
	"settings:flwSecretKey": "test-key",
	"settings:connectPlatformFeePercent": 10,
};

describe("checkout hands a split-capable provider exact allocations", () => {
	it("computes per-vendor amounts and the platform remainder", async () => {
		const { provider, seen } = recordingProvider({ capabilities: { splits: true } });
		registerPaymentProvider(provider);
		const { ctx, getCol } = makeRouteContext(settings);
		getCol("vendors").set("v1", vendor("v1"));
		getCol("vendors").set("v2", vendor("v2"));

		const res = await startCheckout(ctx, "sess_split_1", splitCart("sess_split_1"));
		expect(res.status).toBe(200);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.allocations).toEqual([
			{ vendorId: "v1", accountReference: "RS_V1", amountMinor: 135_000 },
			{ vendorId: "v2", accountReference: "RS_V2", amountMinor: 135_000 },
		]);
		// 450_000 total - 270_000 to vendors = platform item 150_000 + 30_000 fees.
		expect(seen[0]?.platformRemainderMinor).toBe(180_000);
	});

	it("sends no allocations for a cart without vendor items", async () => {
		const { provider, seen } = recordingProvider({ capabilities: { splits: true } });
		registerPaymentProvider(provider);
		const { ctx } = makeRouteContext(settings);

		const res = await startCheckout(ctx, "sess_split_2", ticketCart("sess_split_2"));
		expect(res.status).toBe(200);
		expect(seen[0]?.allocations).toBeUndefined();
		expect(seen[0]?.platformRemainderMinor).toBeUndefined();
	});

	it("refuses a vendor cart when the provider cannot split", async () => {
		const { provider } = recordingProvider();
		registerPaymentProvider(provider);
		const { ctx, getCol } = makeRouteContext(settings);
		getCol("vendors").set("v1", vendor("v1"));
		getCol("vendors").set("v2", vendor("v2"));

		const res = await startCheckout(ctx, "sess_split_3", splitCart("sess_split_3"));
		expect(res.status).toBe(409);
		const body = (await res.json()) as { unsupported?: string[] };
		expect(body.unsupported).toContain("splits");
	});

	it("refuses the checkout when a vendor has no active account", async () => {
		const { provider } = recordingProvider({ capabilities: { splits: true } });
		registerPaymentProvider(provider);
		const { ctx, getCol } = makeRouteContext(settings);
		getCol("vendors").set("v1", vendor("v1", { paymentAccounts: {} }));
		getCol("vendors").set("v2", vendor("v2"));

		const res = await startCheckout(ctx, "sess_split_4", splitCart("sess_split_4"));
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("has no flw payout account");
	});
});

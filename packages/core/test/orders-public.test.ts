import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { maskEmail, ordersPublicRoutes } from "../src/routes/orders-public";

/**
 * Regression tests for issue #68: the public /orders/by-draft poll must
 * not return the full stored order (addresses, Stripe ids, IP, metadata).
 */

const DRAFT = "draft_abc123";

const storedOrder = {
	orderNumber: "000042",
	status: "processing",
	paymentStatus: "paid",
	customerId: "cus_internal_1",
	customerEmail: "jane.doe@example.com",
	currency: "USD",
	billingAddress: { line1: "1 Secret St", city: "El Paso", postalCode: "79901" },
	shippingAddress: { line1: "1 Secret St", city: "El Paso", postalCode: "79901" },
	subtotal: { currency: "USD", amount: 2000 },
	discountTotal: { currency: "USD", amount: 0 },
	shippingTotal: { currency: "USD", amount: 0 },
	taxTotal: { currency: "USD", amount: 0 },
	total: { currency: "USD", amount: 2000 },
	paidTotal: { currency: "USD", amount: 2000 },
	refundedTotal: { currency: "USD", amount: 0 },
	taxLines: [],
	couponCodes: ["SECRET50"],
	stripePaymentIntentId: "pi_secret",
	stripeCustomerId: "cus_stripe_secret",
	stripeChargeId: "ch_secret",
	metadata: { orderDraftId: DRAFT, cartId: "cart_secret" },
	ipAddress: "203.0.113.7",
	userAgent: "SecretBrowser/1.0",
	customerNote: "leave at back door",
	createdAt: "2026-11-14T00:00:00.000Z",
	updatedAt: "2026-11-14T00:00:00.000Z",
};

const storedItem = {
	orderId: "ord_1",
	productId: "prod_1",
	sku: "SKU-1",
	name: "Dossier No. 7",
	quantity: 1,
	unitPrice: { currency: "USD", amount: 2000 },
	lineSubtotal: { currency: "USD", amount: 2000 },
	discountAmount: { currency: "USD", amount: 0 },
	taxAmount: { currency: "USD", amount: 0 },
	total: { currency: "USD", amount: 2000 },
	isDigital: true,
	vendorId: "vendor_secret",
};

function ctxWithOrder(): PluginContext {
	return {
		storage: {
			orders: {
				query: async () => ({
					items: [{ id: "ord_1", data: storedOrder }],
					cursor: null,
					hasMore: false,
				}),
			},
			order_items: {
				query: async () => ({
					items: [{ id: "item_1", data: storedItem }],
					cursor: null,
					hasMore: false,
				}),
			},
		},
		kv: { get: async () => null },
	} as unknown as PluginContext;
}

async function poll(ctx: PluginContext) {
	const req = new Request(
		`http://localhost/_emdash/api/plugins/dashcommerce/orders/by-draft?id=${DRAFT}`,
	);
	const res = await ordersPublicRoutes["orders/by-draft"].handler(
		{ request: req } as RouteContext,
		ctx,
	);
	return (await res.json()) as {
		status: string;
		order: Record<string, unknown>;
		items: Record<string, unknown>[];
	};
}

describe("GET /orders/by-draft (issue #68)", () => {
	it("returns only the thank-you page fields", async () => {
		const body = await poll(ctxWithOrder());
		expect(body.status).toBe("ready");
		expect(body.order).toEqual({
			id: "ord_1",
			orderNumber: "000042",
			status: "processing",
			customerEmail: "j***@example.com",
			currency: "USD",
			total: { currency: "USD", amount: 2000 },
		});
		expect(body.items).toEqual([
			{
				id: "item_1",
				name: "Dossier No. 7",
				quantity: 1,
				total: { currency: "USD", amount: 2000 },
			},
		]);
	});

	it("leaks none of the sensitive stored values", async () => {
		const raw = JSON.stringify(await poll(ctxWithOrder()));
		for (const secret of [
			"Secret St",
			"pi_secret",
			"cus_stripe_secret",
			"ch_secret",
			"cus_internal_1",
			"203.0.113.7",
			"SecretBrowser",
			"cart_secret",
			DRAFT,
			"SECRET50",
			"back door",
			"vendor_secret",
			"jane.doe",
		]) {
			expect(raw).not.toContain(secret);
		}
	});

	it("still reports pending and failed states", async () => {
		const empty = {
			query: async () => ({ items: [], cursor: null, hasMore: false }),
		};
		const pending = {
			storage: { orders: empty, order_items: empty },
			kv: { get: async () => ({ snapshot: true }) },
		} as unknown as PluginContext;
		expect((await poll(pending)).status).toBe("pending");

		const failed = {
			storage: { orders: empty, order_items: empty },
			kv: { get: async () => null },
		} as unknown as PluginContext;
		expect((await poll(failed)).status).toBe("failed");
	});
});

describe("maskEmail", () => {
	it("masks the local part", () => {
		expect(maskEmail("jane.doe@example.com")).toBe("j***@example.com");
		expect(maskEmail("a@b.co")).toBe("a***@b.co");
	});
	it("handles missing or malformed input", () => {
		expect(maskEmail(undefined)).toBe("");
		expect(maskEmail("not-an-email")).toBe("***");
	});
});

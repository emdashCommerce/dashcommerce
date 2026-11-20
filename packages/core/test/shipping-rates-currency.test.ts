/**
 * Shipping methods priced in a currency other than the cart's must not be
 * offered. Offering one made `recalculate` add, say, USD to a KES cart and
 * throw CurrencyMismatchError, so choosing it failed with a 500.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { recalculate } from "../src/cart/calculate";
import { cartKey } from "../src/cart/store";
import { cartRoutes } from "../src/routes/cart";
import { money, zero } from "../src/money";
import { calculateRates } from "../src/shipping/calculate";
import { requoteShippingMethod } from "../src/shipping/requote";
import type { CartLineItem, CartState, ShippingMethod, ShippingMethodConfig } from "../src/types";

function line(currency: string, unit: number): CartLineItem {
	return {
		lineId: "l-a",
		productId: "a",
		quantity: 1,
		unitPrice: money(currency, unit),
		lineSubtotal: money(currency, unit),
		title: "Item",
		isDigital: false,
		weightGrams: 500,
	};
}

function kesCart(shippingMethod: CartState["shippingMethod"]): CartState {
	return {
		sessionId: "sess",
		currency: "KES",
		items: [line("KES", 100_000)],
		coupons: [],
		taxLines: [],
		subtotal: zero("KES"),
		discountTotal: zero("KES"),
		shippingTotal: zero("KES"),
		taxTotal: zero("KES"),
		total: zero("KES"),
		shippingMethod,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function method(id: string, config: ShippingMethodConfig): ShippingMethod {
	return {
		id,
		zoneId: "z1",
		title: id,
		order: 0,
		enabled: true,
		config,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const usdMethods = [
	method("flat-usd", { type: "flat_rate", amount: money("USD", 800) }),
	method("pickup-usd", { type: "local_pickup", amount: money("USD", 200) }),
	method("free-over-usd", { type: "free_shipping", minimumAmount: money("USD", 5_000) }),
	method("weight-usd", { type: "weight_based", currency: "USD", base: money("USD", 300), perGram: 1 }),
];

describe("shipping rates and currency", () => {
	it("offers no method priced in another currency", () => {
		const options = calculateRates({
			items: [line("KES", 100_000)],
			currency: "KES",
			methods: usdMethods,
		});
		expect(options).toEqual([]);
	});

	it("still offers methods priced in the cart's currency", () => {
		const options = calculateRates({
			items: [line("KES", 100_000)],
			currency: "KES",
			methods: [
				...usdMethods,
				method("flat-kes", { type: "flat_rate", amount: money("KES", 30_000) }),
				method("pickup-free", { type: "local_pickup" }),
				method("free-over-kes", { type: "free_shipping", minimumAmount: money("KES", 50_000) }),
				method("free-always", { type: "free_shipping" }),
			],
		});
		expect(options.map((o) => o.methodId)).toEqual([
			"flat-kes",
			"pickup-free",
			"free-over-kes",
			"free-always",
		]);
		for (const o of options) expect(o.amount.currency).toBe("KES");
	});

	it("drops a stored method in another currency instead of failing the totals", () => {
		const cart = kesCart({ id: "flat-usd", label: "flat-usd", amount: money("USD", 800) });
		const requoted = requoteShippingMethod(cart, usdMethods);
		expect(requoted.shippingMethod).toBeUndefined();
		expect(() => recalculate(requoted)).not.toThrow();
	});
});

describe("cart shipping routes with a method in another currency", () => {
	const sid = "sess-kes";
	const address = {
		firstName: "Test",
		lastName: "User",
		line1: "1 Road",
		city: "Nairobi",
		region: "",
		postalCode: "00100",
		country: "KE",
	};

	function ctxWith(cart: CartState, methods: ShippingMethod[]) {
		const kv = new Map<string, unknown>([[cartKey(sid), cart]]);
		const rows = <T>(items: Array<T & { id: string }>) => ({
			async query() {
				return { items: items.map((data) => ({ id: data.id, data })) };
			},
		});
		return {
			kv: {
				async get(k: string) {
					return kv.get(k) ?? null;
				},
				async set(k: string, v: unknown) {
					kv.set(k, v);
				},
				async delete(k: string) {
					return kv.delete(k);
				},
				async list() {
					return [];
				},
			},
			storage: {
				shipping_zones: rows([
					{
						id: "z1",
						name: "Kenya",
						locations: [{ country: "KE" }],
						order: 0,
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				]),
				shipping_methods: rows(methods),
			},
			log: { debug() {}, info() {}, warn() {}, error() {} },
		} as unknown as PluginContext;
	}

	function routeCtx(path: string, input: unknown, method: string): RouteContext {
		return {
			input,
			request: new Request(`http://test${path}`, {
				method,
				headers: { cookie: `dashcommerce_sid=${sid}` },
			}),
			requestMeta: { ip: null, userAgent: null, referer: null, geo: null },
		} as unknown as RouteContext;
	}

	const kesMethods = [method("flat-kes", { type: "flat_rate", amount: money("KES", 11_000) })];
	const usdCart = (): CartState => ({
		...kesCart(undefined),
		currency: "USD",
		items: [line("USD", 1_599)],
		shippingAddress: address,
	});

	it("GET /cart/shipping-methods doesn't list it", async () => {
		const res = await cartRoutes["cart/shipping-methods"].handler(
			routeCtx("/cart/shipping-methods", {}, "GET"),
			ctxWith(usdCart(), kesMethods),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(200);
		expect(((await res.json()) as { options: unknown[] }).options).toEqual([]);
	});

	it("POST /cart/shipping-method refuses it with a 409, not a 500", async () => {
		const res = await cartRoutes["cart/shipping-method"].handler(
			routeCtx("/cart/shipping-method", { methodId: "flat-kes" }, "POST"),
			ctxWith(usdCart(), kesMethods),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(409);
	});
});

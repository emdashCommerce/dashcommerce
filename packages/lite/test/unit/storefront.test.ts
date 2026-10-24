/**
 * The storefront kit (storefront/dashcommerce.js) against the real route
 * handlers, with fetch routed in-process and EmDash's `{ success, data }`
 * envelope applied.
 */

import { describe, expect, test } from "bun:test";
import plugin from "../../src/plugin";
import {
	CART_EVENT,
	createClient,
	DashCommerceError,
	DEFAULT_BASE,
	formatMoney,
	orderFromQuery,
	STORAGE_KEY,
} from "../../storefront/dashcommerce.js";
import { makeCtx, product } from "../helpers/fake-ctx";
import { okStripe, pay, SK, WH } from "../helpers/flow";

type Route = { handler: (routeCtx: unknown, ctx: unknown) => Promise<unknown> };

function harness(
	products = [product("mug"), product("few", { manage_stock: 1, stock_quantity: 1 })],
) {
	const t = makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH },
		products,
		stripe: okStripe,
	});
	const requests: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchImpl = (async (input: string, init: RequestInit = {}) => {
		const url = new URL(input, "https://shop.example");
		expect(url.pathname.startsWith(`${DEFAULT_BASE}/`)).toBe(true);
		const name = url.pathname.slice(DEFAULT_BASE.length + 1);
		const headers = Object.fromEntries(
			Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
				k.toLowerCase(),
				v,
			]),
		);
		requests.push({ url: input, headers });
		const route = (plugin.routes as Record<string, Route>)[name];
		if (!route)
			return Response.json(
				{ success: false, error: { code: "NOT_FOUND", message: "nope" } },
				{ status: 404 },
			);
		const input_ =
			init.method === "GET" || !init.body
				? Object.fromEntries(url.searchParams)
				: JSON.parse(String(init.body));
		const data = await route.handler(
			{ input: input_, request: { url: input, method: init.method, headers } },
			t.ctx,
		);
		return Response.json({ success: true, data });
	}) as unknown as typeof fetch;
	const store = new Map<string, string>();
	const storage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	};
	const events = new EventTarget();
	const seen: unknown[] = [];
	events.addEventListener(CART_EVENT, (e) => seen.push((e as CustomEvent).detail));
	const shop = createClient({ fetch: fetchImpl, storage, events });
	return { t, shop, store, requests, seen };
}

describe("storefront kit", () => {
	test("cart round trip keeps the token and emits cart events", async () => {
		const { shop, store, requests, seen } = harness();
		expect((await shop.getCart()).items).toEqual([]);
		expect(store.has(STORAGE_KEY)).toBe(false);

		const cart = await shop.addItem("mug", 2);
		expect(cart.total.amount).toBe(3000);
		const token = store.get(STORAGE_KEY);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const again = await shop.addItem("mug");
		expect(again.itemCount).toBe(3);
		expect(requests.at(-1)?.headers["x-dashcommerce-cart"]).toBe(token);

		const lineId = again.items[0]?.lineId as string;
		expect((await shop.updateItem(lineId, 1)).itemCount).toBe(1);
		expect((await shop.removeItem(lineId)).items).toHaveLength(0);
		expect(seen.length).toBeGreaterThanOrEqual(5);
	});

	test("errors carry the route's code", async () => {
		const { shop } = harness();
		await shop.addItem("few", 1);
		const err = await shop.addItem("few", 1).catch((e) => e);
		expect(err).toBeInstanceOf(DashCommerceError);
		expect(err.code).toBe("INSUFFICIENT_STOCK");
	});

	test("checkout, then wait for payment on the success page", async () => {
		const { t, shop, store } = harness();
		await shop.addItem("mug", 1);
		const co = await shop.checkout({ email: "a@b.co" });
		expect(co.url).toStartWith("https://checkout.stripe.com/");

		let polls = 0;
		const order = await shop.waitForPayment(co.orderId, co.orderKey, {
			intervalMs: 1,
			sleep: async () => {
				polls += 1;
				if (polls === 2) {
					const o = (await t.orders.get(co.orderId)) as { stripeSessionId: string };
					await pay(t, { orderId: co.orderId, sessionId: o.stripeSessionId, total: 1500 });
				}
			},
		});
		expect(order).toMatchObject({ paymentStatus: "paid", orderNumber: co.orderNumber });
		expect(polls).toBe(2);
		expect(store.has(STORAGE_KEY)).toBe(false);

		const wrongKey = await shop.getOrder(co.orderId, "nope").catch((e) => e);
		expect(wrongKey.code).toBe("ORDER_NOT_FOUND");
	});

	test("checkout repeats the request while the server answers CHECKOUT_CONTINUE", async () => {
		const products = Array.from({ length: 1000 }, (_, i) => product(`p${i}`));
		const { shop, requests } = harness(products);
		for (let i = 0; i < 20; i += 1) await shop.addItem(`p${i * 50}`, 1);
		const before = requests.length;
		const co = await shop.checkout();
		expect(co.url).toStartWith("https://checkout.stripe.com/");
		const sent = requests.length - before;
		expect(sent).toBeGreaterThan(1);
		expect(sent).toBeLessThanOrEqual(4);
	});

	test("helpers", () => {
		expect(orderFromQuery("?order=o1&key=k1")).toEqual({ id: "o1", orderKey: "k1" });
		expect(orderFromQuery("?order=o1")).toBeNull();
		expect(formatMoney({ currency: "USD", amount: 1999 }, "en-US")).toBe("$19.99");
		expect(formatMoney({ currency: "JPY", amount: 500 }, "en-US")).toBe("¥500");
	});
});

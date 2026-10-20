/**
 * End-to-end flow inside the workerd sandbox: storefront cart routes,
 * Checkout Session creation (Stripe stubbed at the bridge), the signed
 * webhook through the real route dispatcher, and the Block Kit pages.
 */

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

const SK = "sk_test_sandbox123456";
const WH = "whsec_sandboxsecret123";
const HEADER = "x-dashcommerce-cart";

let host: PluginRuntimeTestHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function setup() {
	const h = await createPluginRuntimeTestHost({
		site: { url: "https://shop.example", name: "Shop" },
	});
	host = h;
	await h.fixtures.collection({
		slug: "products",
		label: "Products",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "type", label: "Type", type: "string" },
			{ slug: "prices", label: "Prices", type: "json" },
			{ slug: "sku", label: "SKU", type: "string" },
			{ slug: "stock_status", label: "Stock status", type: "string" },
			{ slug: "backorders", label: "Backorders", type: "string" },
		],
	});
	const item = await h.fixtures.content("products", {
		slug: "mug",
		status: "published",
		data: {
			title: "Mug",
			type: "simple",
			prices: { USD: { amount: 1200 } },
			sku: "MUG",
			stock_status: "instock",
			backorders: "no",
		},
	});
	return { h, productId: item.id };
}

async function call(
	h: PluginRuntimeTestHost,
	name: string,
	init: Parameters<PluginRuntimeTestHost["actions"]["routes"]["request"]>[1],
) {
	const res = await h.actions.routes.request(name, init);
	const body = (await res.json()) as { success?: boolean; data?: Record<string, unknown> };
	return { status: res.status, body };
}

async function sign(payload: string, secret: string, t: number) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
	return `t=${t},v1=${Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("DashCommerce Lite in the sandbox", () => {
	it("runs cart -> checkout -> signed webhook -> admin", async () => {
		const { h, productId } = await setup();
		await h.fixtures.plugin.setting("stripeSecretKey", SK);
		await h.fixtures.plugin.setting("stripeWebhookSecret", WH);

		// Cart: first add mints a token.
		const added = await call(h, "cart/items", { method: "POST", body: { productId, quantity: 2 } });
		expect(added.status).toBe(200);
		const data = added.body.data as {
			ok: boolean;
			token: string;
			cart: { total: { amount: number } };
		};
		expect(data.ok).toBe(true);
		expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(data.cart.total.amount).toBe(2400);
		const headers = { [HEADER]: data.token };

		const read = await call(h, "cart", { method: "GET", headers });
		expect((read.body.data as { cart: { itemCount: number } }).cart.itemCount).toBe(2);

		// Checkout: Stripe answered by the bridge stub.
		await h.http.respond(
			"https://api.stripe.com/v1/checkout/sessions",
			new Response(
				JSON.stringify({
					id: "cs_test_sbx",
					object: "checkout.session",
					url: "https://checkout.stripe.com/c/pay/cs_test_sbx",
				}),
				{
					headers: { "content-type": "application/json" },
				},
			),
		);
		const checkout = await call(h, "checkout/session", { method: "POST", headers, body: {} });
		const co = checkout.body.data as {
			ok: boolean;
			orderId: string;
			orderKey: string;
			url: string;
		};
		expect(co).toMatchObject({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_sbx" });
		const [stripeReq] = h.http.requests();
		expect(stripeReq?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
		expect(new TextDecoder().decode(stripeReq?.body)).toContain(
			"line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1200",
		);

		// Webhook with a bad signature is refused with 400.
		const payload = JSON.stringify({
			id: "evt_sbx_1",
			type: "checkout.session.completed",
			data: {
				object: {
					id: "cs_test_sbx",
					object: "checkout.session",
					client_reference_id: co.orderId,
					metadata: { orderId: co.orderId },
					payment_status: "paid",
					amount_total: 2400,
					currency: "usd",
					payment_intent: "pi_sbx",
					customer_details: { email: "buyer@example.com" },
				},
			},
		});
		const t = Math.floor(Date.now() / 1000);
		const bad = await h.actions.routes.request("stripe/webhook", {
			method: "POST",
			headers: {
				"stripe-signature": await sign(payload, "whsec_wrong12345678", t),
				"content-type": "application/json",
			},
			rawBody: payload,
		});
		expect(bad.status).toBe(400);

		const good = await h.actions.routes.request("stripe/webhook", {
			method: "POST",
			headers: {
				"stripe-signature": await sign(payload, WH, t),
				"content-type": "application/json",
			},
			rawBody: payload,
		});
		expect(good.status).toBe(200);
		expect(await good.json()).toMatchObject({ received: true, outcome: "paid" });

		const order = await h.inspect.storage.get<Record<string, unknown>>("orders", co.orderId);
		expect(order).toMatchObject({
			status: "processing",
			paymentStatus: "paid",
			customerEmail: "buyer@example.com",
		});

		// Order status for the success page.
		const status = await call(h, "order", {
			method: "GET",
			url: `https://shop.example/_emdash/api/plugins/dashcommerce-lite/order?id=${co.orderId}&key=${co.orderKey}`,
		});
		expect(status.body.data).toMatchObject({ ok: true, order: { paymentStatus: "paid" } });

		// Paid cart is gone.
		const after = await call(h, "cart", { method: "GET", headers });
		expect((after.body.data as { token: unknown }).token).toBeNull();

		// Block Kit pages render and pass host validation.
		const orders = await h.admin.loadPage("/orders");
		expect(JSON.stringify(orders)).toContain(String(order?.orderNumber));
		const settings = await h.admin.loadPage("/settings");
		expect(JSON.stringify(settings)).not.toContain(SK);
	});

	it("explains a missing EMDASH_ENCRYPTION_KEY instead of failing", async () => {
		const { h } = await setup();
		const res = await h.admin.submit("/settings", "save_settings", {
			stripeSecretKey: SK,
			currency: "usd",
			successUrl: "/thanks",
			cancelUrl: "/cart",
			shippingCountries: "",
		});
		expect(res.toast?.type).toBe("error");
		expect(JSON.stringify(res)).toContain("EMDASH_ENCRYPTION_KEY");
		expect(await h.inspect.setting("stripeSecretKey")).toBeNull();
	});

	it("encrypts Stripe secrets saved from the settings form", async () => {
		const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
			.process.env;
		// Test-only key: "emdash_enc_v1_" + 32 zero bytes, base64url.
		env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${"A".repeat(43)}`;
		const { h, productId } = await setup();
		const res = await h.admin.submit("/settings", "save_settings", {
			stripeSecretKey: SK,
			stripeWebhookSecret: WH,
			currency: "usd",
			successUrl: "/thanks",
			cancelUrl: "/cart",
			shippingCountries: "",
		});
		expect(res.toast?.type).toBe("success");
		const raw = JSON.stringify(await h.inspect.settings.raw("stripeSecretKey"));
		expect(raw).toContain('"$emdash":"plugin-setting"');
		expect(raw).not.toContain(SK);

		// The plugin reads the decrypted key back when it calls Stripe.
		const added = await call(h, "cart/items", { method: "POST", body: { productId } });
		const token = (added.body.data as { token: string }).token;
		await h.http.respond(
			"https://api.stripe.com/v1/checkout/sessions",
			new Response(
				JSON.stringify({
					id: "cs_enc",
					object: "checkout.session",
					url: "https://checkout.stripe.com/c/pay/cs_enc",
				}),
			),
		);
		const co = await call(h, "checkout/session", {
			method: "POST",
			headers: { [HEADER]: token },
			body: {},
		});
		expect(co.body.data).toMatchObject({ ok: true });
		expect(h.http.requests()[0]?.headers.authorization).toBe(`Bearer ${SK}`);
		env.EMDASH_ENCRYPTION_KEY = undefined;
	});
});

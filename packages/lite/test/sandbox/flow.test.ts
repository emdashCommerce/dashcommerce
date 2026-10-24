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
			{ slug: "manage_stock", label: "Manage stock", type: "boolean" },
			{ slug: "stock_quantity", label: "Stock quantity", type: "integer" },
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
			manage_stock: true,
			stock_quantity: 5,
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

describe("DashCommerce (sandboxed) in workerd", () => {
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
		// Marking paid uses the request's budget; the stock is taken by a
		// one-shot cron task on the next tick.
		expect(await good.json()).toMatchObject({ received: true, outcome: "paid_stock_pending" });
		h.scheduled.setTime(new Date(Date.now() + 61_000));
		await h.scheduled.run();

		const order = await h.inspect.storage.get<Record<string, unknown>>("orders", co.orderId);
		expect(order).toMatchObject({
			status: "processing",
			paymentStatus: "paid",
			customerEmail: "buyer@example.com",
			stock: "deducted",
		});
		// Stock ledger: 5 on the product, 2 sold, written with a guarded
		// updateIf, plus the per-order, per-product move on the order.
		expect(await h.inspect.storage.get("stock", productId)).toMatchObject({
			onHand: 3,
			baseline: 5,
		});
		expect((order?.stockMoves as Record<string, unknown> | undefined)?.[productId]).toMatchObject({
			state: "deducted",
			quantity: 2,
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
		const stock = await h.admin.loadPage("/stock");
		expect(JSON.stringify(stock)).toContain('"onHand":3');
		const widget = await h.admin.loadWidget("recent-orders");
		expect(JSON.stringify(widget)).toContain(String(order?.orderNumber));

		// Full refund through the real dispatcher: payment and stock go back.
		const refundPayload = JSON.stringify({
			id: "evt_sbx_refund",
			type: "charge.refunded",
			data: {
				object: {
					id: "ch_sbx",
					object: "charge",
					amount: 2400,
					amount_refunded: 2400,
					currency: "usd",
					payment_intent: "pi_sbx",
					refunded: true,
				},
			},
		});
		const refunded = await h.actions.routes.request("stripe/webhook", {
			method: "POST",
			headers: {
				"stripe-signature": await sign(refundPayload, WH, t),
				"content-type": "application/json",
			},
			rawBody: refundPayload,
		});
		expect(await refunded.json()).toMatchObject({ outcome: "refunded" });
		expect(await h.inspect.storage.get("orders", co.orderId)).toMatchObject({
			status: "refunded",
			paymentStatus: "refunded",
			refundedAmount: 2400,
			stock: "restored",
		});
		// This charge has no metadata, so the order is found by its
		// PaymentIntent (one more call) and the restore runs in a cron task.
		h.scheduled.setTime(new Date(Date.now() + 122_000));
		await h.scheduled.run();
		expect(await h.inspect.storage.get("stock", productId)).toMatchObject({ onHand: 5 });
		const afterRefund = await h.inspect.storage.get<Record<string, unknown>>("orders", co.orderId);
		expect(
			(afterRefund?.stockMoves as Record<string, unknown> | undefined)?.[productId],
		).toMatchObject({ state: "restored" });

		// Replaying the paid event under a new id leaves the refunded order alone.
		const replayPayload = payload.replace("evt_sbx_1", "evt_sbx_replay");
		const replay = await h.actions.routes.request("stripe/webhook", {
			method: "POST",
			headers: {
				"stripe-signature": await sign(replayPayload, WH, t),
				"content-type": "application/json",
			},
			rawBody: replayPayload,
		});
		expect(await replay.json()).toMatchObject({ outcome: "unchanged" });
		expect(await h.inspect.storage.get("orders", co.orderId)).toMatchObject({
			status: "refunded",
			paymentStatus: "refunded",
		});
		expect(await h.inspect.storage.get("stock", productId)).toMatchObject({ onHand: 5 });

		// CSV export: the Orders page mints a one-time link to a raw route.
		const exp = await h.admin.act("/orders", "export_csv", { value: "all" });
		const token = JSON.stringify(exp).match(/orders\/export\?token=([A-Za-z0-9_-]{43})/)?.[1];
		expect(token).toBeDefined();
		const csv = await h.actions.routes.request("orders/export", {
			method: "GET",
			url: `https://shop.example/_emdash/api/plugins/dashcommerce-lite/orders/export?token=${token}`,
		});
		expect(csv.status).toBe(200);
		expect(csv.headers.get("content-type")).toContain("text/csv");
		expect(csv.headers.get("content-disposition")).toContain("attachment;");
		expect(await csv.text()).toContain(String(order?.orderNumber));
		const reused = await h.actions.routes.request("orders/export", {
			method: "GET",
			url: `https://shop.example/_emdash/api/plugins/dashcommerce-lite/orders/export?token=${token}`,
		});
		expect(reused.status).toBe(403);
	});

	it("schedules the cleanup task and runs it through the cron hook", async () => {
		const { h, productId } = await setup();
		await h.actions.plugin.activate();
		const tasks = await h.inspect.scheduledTasks();
		expect(JSON.stringify(tasks)).toContain("cleanup");

		// An expired cart and a stale pending order.
		await h.fixtures.plugin.storage("carts", "c".repeat(64), {
			cart: { sessionId: "c".repeat(64), currency: "USD", items: [] },
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		await h.fixtures.plugin.storage("orders", "stale1", {
			orderNumber: "DCL-STALE",
			orderKey: "k",
			cartId: "x",
			status: "pending",
			paymentStatus: "pending",
			currency: "USD",
			items: [{ productId, title: "Mug", quantity: 1 }],
			subtotal: { currency: "USD", amount: 1200 },
			total: { currency: "USD", amount: 1200 },
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
		});
		// An old order waiting for a bank debit to clear.
		await h.fixtures.plugin.storage("orders", "async1", {
			orderNumber: "DCL-ASYNC",
			orderKey: "k",
			cartId: "y",
			status: "on-hold",
			paymentStatus: "pending",
			awaitingAsyncPayment: true,
			currency: "USD",
			items: [{ productId, title: "Mug", quantity: 1 }],
			subtotal: { currency: "USD", amount: 1200 },
			total: { currency: "USD", amount: 1200 },
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
		});
		await h.transport.invokeHook("cron", {
			name: "cleanup",
			scheduledAt: new Date().toISOString(),
		});
		expect(await h.inspect.storage.get("carts", "c".repeat(64))).toBeNull();
		expect(await h.inspect.storage.get("orders", "stale1")).toMatchObject({
			status: "cancelled",
			cancelReason: "stale",
		});
		expect(await h.inspect.storage.get("orders", "async1")).toMatchObject({
			status: "on-hold",
			awaitingAsyncPayment: true,
		});
	});

	it("takes stock for a large order in follow-up cron tasks", async () => {
		const { h, productId } = await setup();
		await h.fixtures.plugin.setting("stripeSecretKey", SK);
		await h.fixtures.plugin.setting("stripeWebhookSecret", WH);
		const ids = [productId];
		for (let i = 0; i < 5; i += 1) {
			const item = await h.fixtures.content("products", {
				slug: `cup-${i}`,
				status: "published",
				data: {
					title: `Cup ${i}`,
					type: "simple",
					prices: { USD: { amount: 500 } },
					sku: `CUP${i}`,
					stock_status: "instock",
					backorders: "no",
					manage_stock: true,
					stock_quantity: 9,
				},
			});
			ids.push(item.id);
		}
		let token: string | undefined;
		for (const id of ids) {
			const res = await call(h, "cart/items", {
				method: "POST",
				headers: token ? { [HEADER]: token } : {},
				body: { productId: id, quantity: 1 },
			});
			token = (res.body.data as { token: string }).token;
		}
		const headers = { [HEADER]: token as string };
		// No install or activate hook ran: the cart route scheduled the
		// recurring tasks itself.
		expect(JSON.stringify(await h.inspect.scheduledTasks())).toContain("stock-sweep");

		await h.http.respond(
			"https://api.stripe.com/v1/checkout/sessions",
			new Response(
				JSON.stringify({
					id: "cs_test_big",
					object: "checkout.session",
					url: "https://checkout.stripe.com/c/pay/cs_test_big",
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		const checkout = await call(h, "checkout/session", { method: "POST", headers, body: {} });
		const co = checkout.body.data as { ok: boolean; orderId: string };
		expect(co.ok).toBe(true);
		const total = 1200 + 5 * 500;
		const payload = JSON.stringify({
			id: "evt_big",
			type: "checkout.session.completed",
			data: {
				object: {
					id: "cs_test_big",
					object: "checkout.session",
					client_reference_id: co.orderId,
					metadata: { orderId: co.orderId },
					payment_status: "paid",
					amount_total: total,
					currency: "usd",
					payment_intent: "pi_big",
				},
			},
		});
		const t = Math.floor(Date.now() / 1000);
		const res = await h.actions.routes.request("stripe/webhook", {
			method: "POST",
			headers: {
				"stripe-signature": await sign(payload, WH, t),
				"content-type": "application/json",
			},
			rawBody: payload,
		});
		expect(await res.json()).toMatchObject({ outcome: "paid_stock_pending" });
		expect(await h.inspect.storage.get("orders", co.orderId)).toMatchObject({
			paymentStatus: "paid",
			stockPending: 1,
		});

		for (let i = 0; i < 5; i += 1) {
			h.scheduled.setTime(new Date(Date.now() + (i + 1) * 61_000));
			await h.scheduled.run();
			const o = await h.inspect.storage.get<Record<string, unknown>>("orders", co.orderId);
			if (o?.paidEffectsAt) break;
		}
		const done = await h.inspect.storage.get<Record<string, unknown>>("orders", co.orderId);
		expect(done?.paidEffectsAt).toBeTruthy();
		expect(done?.stockPending).toBeUndefined();
		expect(await h.inspect.storage.get("stock", productId)).toMatchObject({ onHand: 4 });
		for (const id of ids.slice(1)) {
			expect(await h.inspect.storage.get("stock", id)).toMatchObject({ onHand: 8 });
		}
	});

	it("syncs stock across a 146-product catalog, oldest first, one page per click", async () => {
		const { h, productId } = await setup();
		// The mug and the next 19 are the oldest products, so a newest-first
		// first page of 100 never reaches them (the Cloudflare test shop).
		const tracked = [productId];
		for (let i = 1; i < 146; i += 1) {
			const item = await h.fixtures.content("products", {
				slug: `p${i}`,
				status: "published",
				data: {
					title: `P${i}`,
					type: "simple",
					prices: { USD: { amount: 500 } },
					...(i < 20 ? { manage_stock: true, stock_quantity: i } : {}),
				},
			});
			if (i < 20) tracked.push(item.id);
		}
		const toasts: string[] = [];
		for (let i = 0; i < 20 && !toasts.at(-1)?.startsWith("Checked all"); i += 1) {
			const res = await h.admin.act("/stock", "sync_stock");
			toasts.push(res.toast?.message ?? "");
		}
		expect(toasts).toContain(
			"Checked 100 products so far (added 20, reset 0). Run Sync again to check the rest.",
		);
		expect(toasts.at(-1)).toBe(
			"Checked all 146 products: added 20, reset 0 from product stock_quantity.",
		);
		for (const [i, id] of tracked.entries()) {
			expect(await h.inspect.storage.get("stock", id)).toMatchObject({ onHand: i === 0 ? 5 : i });
		}
	}, 60_000);

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
		// A first save changes 9 values and stores 7 (secrets first); the
		// second Save stores the rest.
		expect(res.toast?.type).toBe("info");
		const again = await h.admin.submit("/settings", "save_settings", {
			stripeSecretKey: "",
			currency: "usd",
			successUrl: "/thanks",
			cancelUrl: "/cart",
			shippingCountries: "",
		});
		expect(again.toast?.type).toBe("success");
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

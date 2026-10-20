import { describe, expect, test } from "bun:test";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { handleAdmin } from "../../src/admin";
import type { LiteOrder } from "../../src/orders";
import { makeCtx } from "../helpers/fake-ctx";

const policy = { pluginPagePaths: ["/orders", "/settings"] };

function expectValid(res: unknown) {
	const v = validateBlockResponse(res, policy);
	if (!v.valid) throw new Error(JSON.stringify(v.errors));
}

function order(n: number, over: Partial<LiteOrder> = {}): LiteOrder {
	const total = { currency: "USD", amount: 1000 * n };
	return {
		orderNumber: `DCL-${n}`,
		orderKey: "k",
		cartId: "c",
		status: "processing",
		paymentStatus: "paid",
		currency: "USD",
		items: [
			{
				productId: "p",
				title: "Thing",
				quantity: n,
				unitPrice: { currency: "USD", amount: 1000 },
				lineTotal: total,
			},
		],
		subtotal: total,
		total,
		customerEmail: "a@b.co",
		createdAt: new Date(2026, 0, n).toISOString(),
		updatedAt: new Date(2026, 0, n).toISOString(),
		...over,
	};
}

describe("Block Kit admin", () => {
	test("orders page lists orders newest first and validates", async () => {
		const t = makeCtx();
		await t.orders.put("o1", order(1) as never);
		await t.orders.put("o2", order(2, { status: "pending", paymentStatus: "pending" }) as never);
		const res = await handleAdmin(t.ctx, { type: "page_load", page: "/orders" });
		expectValid(res);
		const table = res.blocks.find((b) => b.type === "table") as { rows: Array<{ number: string }> };
		expect(table.rows.map((r) => r.number)).toEqual(["DCL-2", "DCL-1"]);
		const stats = res.blocks.find((b) => b.type === "stats") as { items: Array<{ value: number }> };
		expect(stats.items.map((i) => i.value)).toEqual([1, 1]);
	});

	test("order detail and status changes follow core transitions", async () => {
		const t = makeCtx();
		await t.orders.put("o1", order(1) as never);
		const detail = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "view_order",
			value: "o1",
		});
		expectValid(detail);
		expect(JSON.stringify(detail)).toContain("o1:completed");

		const done = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "set_status",
			value: "o1:completed",
		});
		expectValid(done);
		expect(done.toast?.type).toBe("success");
		expect(await t.orders.get("o1")).toMatchObject({ status: "completed" });

		const illegal = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "set_status",
			value: "o1:on-hold",
		});
		expect(illegal.toast?.type).toBe("error");
		expect(await t.orders.get("o1")).toMatchObject({ status: "completed" });

		const bogus = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "set_status",
			value: "o1:refunded",
		});
		expect(bogus.toast?.type).toBe("error");
	});

	test("settings page never returns secret values", async () => {
		const t = makeCtx({
			settings: {
				stripeSecretKey: "sk_test_secretvalue1",
				stripeWebhookSecret: "whsec_secretvalue1",
			},
		});
		const res = await handleAdmin(t.ctx, { type: "page_load", page: "/settings" });
		expectValid(res);
		const json = JSON.stringify(res);
		expect(json).not.toContain("secretvalue");
		expect(json).toContain('"has_value":true');
		expect(json).toContain(
			"https://shop.example/_emdash/api/plugins/dashcommerce-lite/stripe/webhook",
		);
	});

	const goodValues = {
		stripeSecretKey: "sk_test_abcdefgh1234",
		stripeWebhookSecret: "whsec_abcdefgh1234",
		currency: "gbp",
		successUrl: "/thanks?o={ORDER_ID}",
		cancelUrl: "/cart",
		shippingCountries: "gb, ie",
	};

	test("saving valid settings stores normalized values", async () => {
		const t = makeCtx();
		const res = await handleAdmin(t.ctx, {
			type: "form_submit",
			action_id: "save_settings",
			values: goodValues,
		});
		expectValid(res);
		expect(res.toast?.type).toBe("success");
		expect(Object.fromEntries(t.settings)).toEqual({
			stripeSecretKey: "sk_test_abcdefgh1234",
			stripeWebhookSecret: "whsec_abcdefgh1234",
			currency: "GBP",
			successUrl: "/thanks?o={ORDER_ID}",
			cancelUrl: "/cart",
			shippingCountries: "GB,IE",
		});
	});

	test("an empty secret field keeps the stored secret", async () => {
		const t = makeCtx({ settings: { stripeSecretKey: "sk_test_keepme123456" } });
		await handleAdmin(t.ctx, {
			type: "form_submit",
			action_id: "save_settings",
			values: { ...goodValues, stripeSecretKey: "", stripeWebhookSecret: undefined },
		});
		expect(t.settings.get("stripeSecretKey")).toBe("sk_test_keepme123456");
	});

	test("invalid settings are rejected as a whole", async () => {
		const t = makeCtx();
		const res = await handleAdmin(t.ctx, {
			type: "form_submit",
			action_id: "save_settings",
			values: { ...goodValues, stripeSecretKey: "pk_test_nope12345", cancelUrl: "//evil.example" },
		});
		expectValid(res);
		expect(res.toast?.type).toBe("error");
		expect(t.settings.size).toBe(0);
	});

	test("secrets can be removed explicitly", async () => {
		const t = makeCtx({ settings: { stripeSecretKey: "sk_test_abcdefgh1234" } });
		const res = await handleAdmin(t.ctx, { type: "block_action", action_id: "clear_secret_key" });
		expectValid(res);
		expect(t.settings.has("stripeSecretKey")).toBe(false);
	});

	test("unknown input renders nothing", async () => {
		const t = makeCtx();
		expect(await handleAdmin(t.ctx, "garbage")).toEqual({ blocks: [] });
	});
});

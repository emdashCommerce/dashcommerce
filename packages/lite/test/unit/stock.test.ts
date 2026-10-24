import { describe, expect, test } from "bun:test";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { handleAdmin } from "../../src/admin";
import { addItemHandler } from "../../src/cart-routes";
import type { LiteOrder } from "../../src/orders";
import type { StockRow } from "../../src/stock";
import { makeCtx, product } from "../helpers/fake-ctx";
import {
	addToCart,
	checkout,
	okStripe,
	pay as deliverPaid,
	refund,
	runSettleTasks,
	SK,
	WH,
} from "../helpers/flow";

/** Deliver the paid event, then run the stock tasks it queued. */
async function pay(...args: Parameters<typeof deliverPaid>) {
	const res = await deliverPaid(...args);
	await runSettleTasks(args[0]);
	return res;
}

const policy = { pluginPagePaths: ["/orders", "/stock", "/settings"] };
function expectValid(res: unknown) {
	const v = validateBlockResponse(res, policy);
	if (!v.valid) throw new Error(JSON.stringify(v.errors));
}

function shop(fields: Record<string, unknown> = {}) {
	return makeCtx({
		settings: { stripeSecretKey: SK, stripeWebhookSecret: WH },
		products: [product("mug", { manage_stock: 1, stock_quantity: 3, ...fields }), product("tee")],
		stripe: okStripe,
	});
}

const row = async (t: ReturnType<typeof shop>, id = "mug") =>
	(await t.stock.get(id)) as unknown as StockRow | null;
const order = async (t: ReturnType<typeof shop>, id: string) =>
	(await t.orders.get(id)) as unknown as LiteOrder;

describe("stock ledger", () => {
	test("payment takes stock; the ledger then limits later carts", async () => {
		const t = shop();
		const co = await checkout(
			t,
			await addToCart(t, [
				["mug", 2],
				["tee", 1],
			]),
		);
		expect(await row(t)).toBeNull(); // checkout itself writes no stock
		expect((await order(t, co.orderId)).items[0]?.stock).toEqual({
			baseline: 3,
			backorders: false,
		});

		const res = await pay(t, co);
		expect(res.body).toMatchObject({ outcome: "paid_stock_pending" });
		expect(await row(t)).toMatchObject({
			onHand: 1,
			baseline: 3,
			lastChange: { delta: -2, reason: "sale" },
		});
		expect(await row(t, "tee")).toBeNull(); // untracked product
		expect(await order(t, co.orderId)).toMatchObject({ stock: "deducted", status: "processing" });

		const tooMany = await addItemHandler(t.ctx, {}, { productId: "mug", quantity: 2 });
		expect(tooMany).toMatchObject({
			ok: false,
			error: { code: "INSUFFICIENT_STOCK", message: "Only 1 in stock" },
		});
		expect(await addItemHandler(t.ctx, {}, { productId: "mug", quantity: 1 })).toMatchObject({
			ok: true,
		});
	});

	test("a duplicate payment event does not take stock twice", async () => {
		const t = shop();
		const co = await checkout(t, await addToCart(t, [["mug", 1]]));
		await pay(t, co);
		await pay(t, co);
		expect((await row(t))?.onHand).toBe(2);
	});

	test("changing stock_quantity on the product resets the ledger", async () => {
		const t = shop();
		await pay(t, await checkout(t, await addToCart(t, [["mug", 3]])));
		expect(await addItemHandler(t.ctx, {}, { productId: "mug" })).toMatchObject({
			error: { code: "OUT_OF_STOCK" },
		});
		t.products.set("mug", product("mug", { manage_stock: 1, stock_quantity: 10 }));
		const co = await checkout(t, await addToCart(t, [["mug", 4]]));
		await pay(t, co);
		expect(await row(t)).toMatchObject({ onHand: 6, baseline: 10 });
	});

	test("overselling between checkout and payment puts the later order on hold", async () => {
		const t = shop();
		const a = await checkout(t, await addToCart(t, [["mug", 2]]));
		const b = await checkout(t, await addToCart(t, [["mug", 2]]));
		await pay(t, a);
		const res = await pay(t, b);
		expect(res.body).toMatchObject({ outcome: "paid_stock_pending" });
		expect(await order(t, b.orderId)).toMatchObject({
			status: "on-hold",
			paymentStatus: "paid",
			stockShortfall: [{ productId: "mug", short: 1 }],
		});
		expect((await row(t))?.onHand).toBe(-1);
		const detail = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "view_order",
			value: b.orderId,
		});
		expectValid(detail);
		expect(JSON.stringify(detail)).toContain("Not enough stock");
	});

	test("backorders allow selling below zero without a hold", async () => {
		const t = shop({ backorders: "yes", stock_quantity: 1 });
		const co = await checkout(t, await addToCart(t, [["mug", 3]]));
		expect((await pay(t, co)).body).toMatchObject({ outcome: "paid_stock_pending" });
		expect((await row(t))?.onHand).toBe(-2);
	});

	test("a full refund restores stock once; a partial refund does not", async () => {
		const t = shop();
		const co = await checkout(t, await addToCart(t, [["mug", 2]]));
		await pay(t, co);
		await refund(t, co.orderId, co.total, 500);
		expect((await row(t))?.onHand).toBe(1);
		await refund(t, co.orderId, co.total, co.total);
		expect((await row(t))?.onHand).toBe(3);
		expect(await order(t, co.orderId)).toMatchObject({
			stock: "restored",
			paymentStatus: "refunded",
		});
		await refund(t, co.orderId, co.total, co.total, { id: "evt_again" });
		expect((await row(t))?.onHand).toBe(3);
	});

	test("cancelling a paid order in the admin restores stock", async () => {
		const t = shop();
		const co = await checkout(t, await addToCart(t, [["mug", 2]]));
		await pay(t, co);
		const res = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "set_status",
			value: `${co.orderId}:cancelled`,
		});
		expectValid(res);
		expect(res.toast?.type).toBe("success");
		expect(await row(t)).toMatchObject({ onHand: 3, lastChange: { reason: "cancel" } });
		expect(await order(t, co.orderId)).toMatchObject({
			status: "cancelled",
			stock: "restored",
			cancelReason: "admin",
		});
	});

	test("Stock page: add tracked products, then adjust on hand", async () => {
		const t = shop();
		const empty = await handleAdmin(t.ctx, { type: "page_load", page: "/stock" });
		expectValid(empty);

		const synced = await handleAdmin(t.ctx, { type: "block_action", action_id: "sync_stock" });
		expectValid(synced);
		expect(synced.toast?.message).toContain("added 1");
		expect(await row(t)).toMatchObject({ onHand: 3, baseline: 3, lastChange: { reason: "seed" } });

		const form = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "adjust_stock",
			value: "mug",
		});
		expectValid(form);
		expect(JSON.stringify(form)).toContain('"block_id":"stock-adjust:mug"');

		const saved = await handleAdmin(t.ctx, {
			type: "form_submit",
			action_id: "save_stock",
			block_id: "stock-adjust:mug",
			values: { onHand: 12 },
		});
		expectValid(saved);
		expect(saved.toast?.type).toBe("success");
		expect(await row(t)).toMatchObject({
			onHand: 12,
			baseline: 3,
			lastChange: { delta: 9, reason: "adjust" },
		});
		// The ledger value is what the storefront can sell now.
		expect(await addItemHandler(t.ctx, {}, { productId: "mug", quantity: 12 })).toMatchObject({
			ok: true,
		});

		const bad = await handleAdmin(t.ctx, {
			type: "form_submit",
			action_id: "save_stock",
			block_id: "stock-adjust:mug",
			values: { onHand: -1 },
		});
		expect(bad.toast?.type).toBe("error");
	});
});

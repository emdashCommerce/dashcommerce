import { describe, expect, test } from "bun:test";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { handleAdmin, searchWhere } from "../../src/admin";
import { CSV_COLUMNS, csvCell, handleExport } from "../../src/export";
import type { LiteOrder } from "../../src/orders";
import { makeCtx } from "../helpers/fake-ctx";

const policy = { pluginPagePaths: ["/orders", "/stock", "/settings"] };
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
		customerEmail: `buyer${n}@example.com`,
		stripePaymentIntentId: `pi_${n}`,
		createdAt: new Date(2026, 0, n).toISOString(),
		updatedAt: new Date(2026, 0, n).toISOString(),
		...over,
	};
}

async function seeded() {
	const t = makeCtx();
	await t.orders.put("o1", order(1) as never);
	await t.orders.put("o2", order(2, { status: "pending", paymentStatus: "pending" }) as never);
	await t.orders.put("o3", order(3, { status: "completed" }) as never);
	return t;
}

const rows = (res: { blocks: Array<{ type: string }> }) =>
	res.blocks.find((b) => b.type === "table") as unknown as {
		rows: Array<{ number: string }>;
		page_action_id: string;
	};

describe("orders admin", () => {
	test("status filter keeps the status across pages", async () => {
		const t = await seeded();
		const res = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "filter_status",
			value: "pending",
		});
		expectValid(res);
		expect(rows(res).rows.map((r) => r.number)).toEqual(["DCL-2"]);
		expect(rows(res).page_action_id).toBe("orders_page:pending");
		const page = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "orders_page:pending",
			value: undefined,
		});
		expect(rows(page).rows.map((r) => r.number)).toEqual(["DCL-2"]);
		const all = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "filter_status",
			value: "all",
		});
		expect(rows(all).rows).toHaveLength(3);
	});

	test("search by order number, email and PaymentIntent", async () => {
		const t = await seeded();
		const find = async (q: string) =>
			rows(
				await handleAdmin(t.ctx, {
					type: "form_submit",
					action_id: "search_orders",
					values: { q },
				}),
			).rows.map((r) => r.number);
		expect(await find("dcl-3")).toEqual(["DCL-3"]);
		expect(await find("BUYER1@example.com")).toEqual(["DCL-1"]);
		expect(await find("pi_2")).toEqual(["DCL-2"]);
		expect(await find("nothing")).toEqual([]);
		const res = await handleAdmin(t.ctx, {
			type: "form_submit",
			action_id: "search_orders",
			values: { q: "nothing" },
		});
		expectValid(res);
		expect(JSON.stringify(res)).toContain("Search needs an exact value");
		expect(searchWhere("cs_test_123")).toEqual({ stripeSessionId: "cs_test_123" });
	});

	test("CSV export: one-time link, filtered rows, safe cells", async () => {
		const t = await seeded();
		await t.orders.put(
			"o4",
			order(4, {
				customerEmail: "=cmd@example.com",
				items: [
					{
						productId: "p",
						title: 'Mug, "large"',
						quantity: 1,
						unitPrice: { currency: "USD", amount: 1000 },
						lineTotal: { currency: "USD", amount: 1000 },
					},
				],
			}) as never,
		);
		const res = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "export_csv",
			value: "processing",
		});
		expectValid(res);
		const url = JSON.stringify(res).match(
			/https:\/\/shop\.example\/_emdash\/api\/plugins\/dashcommerce\/orders\/export\?token=([A-Za-z0-9_-]{43})/,
		);
		expect(url).not.toBeNull();
		const token = url?.[1] as string;

		const csv = await handleExport(t.ctx, { token });
		expect(csv.status).toBe(200);
		expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
		expect(csv.headers["content-disposition"]).toMatch(
			/^attachment; filename="dashcommerce-orders-\d{4}-\d{2}-\d{2}\.csv"$/,
		);
		const lines = csv.body.trim().split("\r\n");
		expect(lines[0]).toBe(CSV_COLUMNS.join(","));
		expect(lines).toHaveLength(3); // header + o4 + o1 (processing only)
		expect(lines[1]).toContain("DCL-4");
		expect(lines[1]).toContain("'=cmd@example.com");
		expect(lines[1]).toContain('"1 x Mug, ""large"""');
		expect(lines[2]).toContain("DCL-1,o1,");
		expect(lines[2]).toContain(",10.00,");

		// Single use, and no token at all is refused.
		expect((await handleExport(t.ctx, { token })).status).toBe(403);
		expect((await handleExport(t.ctx, {})).status).toBe(403);
	});

	test("export links expire after 5 minutes", async () => {
		const t = await seeded();
		const res = await handleAdmin(t.ctx, {
			type: "block_action",
			action_id: "export_csv",
			value: "all",
		});
		const token = JSON.stringify(res).match(/token=([A-Za-z0-9_-]{43})/)?.[1] as string;
		expect((await handleExport(t.ctx, { token }, Date.now() + 6 * 60_000)).status).toBe(403);
	});

	test("csvCell quoting", () => {
		expect(csvCell("plain")).toBe("plain");
		expect(csvCell("+1")).toBe("'+1");
		expect(csvCell("a\nb")).toBe('"a\nb"');
	});

	test("recent orders widget renders and validates", async () => {
		const t = await seeded();
		const res = await handleAdmin(t.ctx, { type: "page_load", page: "widget:recent-orders" });
		expectValid(res);
		expect(rows(res).rows.map((r) => r.number)).toEqual(["DCL-3", "DCL-2", "DCL-1"]);
		expect(JSON.stringify(res)).toContain("1 awaiting payment");
	});
});

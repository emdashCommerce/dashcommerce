/**
 * Stock page Sync walks the whole catalog, one page of 100 products per
 * click (oldest first), keeping its place in KV between clicks. Every
 * click stays within the 8-call budget (budget.ts).
 */

import { describe, expect, test } from "bun:test";
import { SYNC_STATE_KEY, handleAdmin } from "../../src/admin";
import type { StockRow } from "../../src/stock";
import { makeCtx, product } from "../helpers/fake-ctx";
import { countCalls } from "../helpers/flow";

const BUDGET = 8;

/** `size` products created in order; `tracked(i)` decides stock tracking. */
function catalog(size: number, tracked: (i: number) => boolean, qty = 7) {
	const products = Array.from({ length: size }, (_, i) =>
		product(
			`p${String(i).padStart(4, "0")}`,
			tracked(i) ? { manage_stock: 1, stock_quantity: qty } : {},
		),
	);
	const t = makeCtx({ settings: { cronVersion: 2 }, products });
	return { t, ids: products.map((p) => p.id) };
}
type Shop = ReturnType<typeof catalog>["t"];

const row = (t: Shop, id: string) => t.stock.rows.get(id)?.data as StockRow | undefined;

async function click(t: Shop) {
	const res = await countCalls(t, () =>
		handleAdmin(t.ctx, { type: "block_action", action_id: "sync_stock" }),
	);
	expect(res.calls).toBeLessThanOrEqual(BUDGET);
	return res.result.toast?.message ?? "";
}

/** Click Sync until a walk completes; returns the toasts. */
async function syncAll(t: Shop, max = 200) {
	const toasts: string[] = [];
	for (let i = 0; i < max; i += 1) {
		const msg = await click(t);
		toasts.push(msg);
		if (msg.startsWith("Checked all")) return toasts;
	}
	throw new Error("sync did not finish");
}

describe("stock sync walks the whole catalog", () => {
	test("146 products, the 20 oldest tracked (the Cloudflare test shop)", async () => {
		// Products 0-19 are the oldest: past the first page of newest-first
		// lists, where the old Sync never looked.
		const { t, ids } = catalog(146, (i) => i < 20);
		const toasts = await syncAll(t);
		for (const id of ids.slice(0, 20)) {
			expect(row(t, id)).toMatchObject({ onHand: 7, baseline: 7, lastChange: { reason: "seed" } });
		}
		expect(t.stock.rows.size).toBe(20);
		// 20 rows at 3 writes per click: 7 clicks on the first page, then one
		// for the second page.
		expect(toasts[0]).toBe(
			"Checking products 1 to 100: 17 stock rows still to update. Run Sync again.",
		);
		expect(toasts).toContain(
			"Checked 100 products so far (added 20, reset 0). Run Sync again to check the rest.",
		);
		expect(toasts.at(-1)).toBe(
			"Checked all 146 products: added 20, reset 0 from product stock_quantity.",
		);
		expect(toasts).toHaveLength(8);
		expect(t.kv.has(SYNC_STATE_KEY)).toBe(false);

		// A second walk finds nothing to do: one click per page.
		expect(await syncAll(t)).toEqual([
			"Checked 100 products so far (added 0, reset 0). Run Sync again to check the rest.",
			"Checked all 146 products. Stock is up to date.",
		]);
	});

	test("1,000 products, tracked ones spread past the first page", async () => {
		const { t, ids } = catalog(1000, (i) => i % 50 === 7);
		const toasts = await syncAll(t);
		const tracked = ids.filter((_, i) => i % 50 === 7);
		expect(tracked).toHaveLength(20);
		for (const id of tracked) expect(row(t, id)).toMatchObject({ onHand: 7, baseline: 7 });
		expect(t.stock.rows.size).toBe(20);
		expect(toasts.at(-1)).toBe(
			"Checked all 1000 products: added 20, reset 0 from product stock_quantity.",
		);
		// 2 tracked per page fit in one click each: 10 clicks for 10 pages.
		expect(toasts).toHaveLength(10);
		expect(t.kv.has(SYNC_STATE_KEY)).toBe(false);
	});

	test("the walk resets when done, when stale, and when the cursor is rejected", async () => {
		const { t } = catalog(250, (i) => i % 10 === 0);
		await syncAll(t);
		expect(t.kv.has(SYNC_STATE_KEY)).toBe(false);

		// Next click starts a new walk from the oldest page.
		expect(await click(t)).toBe(
			"Checked 100 products so far (added 0, reset 0). Run Sync again to check the rest.",
		);
		expect(t.kv.get(SYNC_STATE_KEY)).toMatchObject({ checked: 100 });

		// A walk left for more than a day starts over.
		const stale = t.kv.get(SYNC_STATE_KEY) as Record<string, unknown>;
		t.kv.set(SYNC_STATE_KEY, { ...stale, checked: 200, startedAt: "2020-01-01T00:00:00.000Z" });
		expect(await click(t)).toContain("Checked 100 products so far");

		// A cursor the host rejects starts over in the same click.
		t.kv.set(SYNC_STATE_KEY, { ...stale, cursor: "garbage", startedAt: new Date().toISOString() });
		expect(await click(t)).toContain("Checked 100 products so far");
		expect(t.kv.get(SYNC_STATE_KEY)).toMatchObject({ checked: 100 });
	});

	test("product changes between clicks", async () => {
		const { t, ids } = catalog(250, (i) => i % 34 === 0); // 8 tracked, 3 on the first page
		const id = (i: number) => ids[i] as string;
		expect(await click(t)).toContain("Checked 100 products so far (added 3");

		// Edited on a page already checked: picked up by the next walk.
		t.products.set(id(0), product(id(0), { manage_stock: 1, stock_quantity: 30 }));
		// Edited on a page not checked yet: picked up by this walk.
		t.products.set(id(136), product(id(136), { manage_stock: 1, stock_quantity: 40 }));
		// Unpublished before its page: skipped without an error.
		t.products.set(id(170), {
			...product(id(170), { manage_stock: 1, stock_quantity: 7 }),
			status: "draft",
		});
		// Created during the walk: sorts last, so this walk reaches it.
		t.products.set("new-1", product("new-1", { manage_stock: 1, stock_quantity: 5 }));
		// A sale on a synced row between clicks: Sync leaves its count alone.
		const sold = row(t, id(34)) as StockRow;
		await t.stock.put(id(34), { ...sold, onHand: 4, rev: (sold.rev ?? 0) + 1 });

		const toasts = await syncAll(t);
		expect(toasts.at(-1)).toBe(
			"Checked all 250 products: added 8, reset 0 from product stock_quantity.",
		);
		expect(row(t, id(0))).toMatchObject({ onHand: 7, baseline: 7 });
		expect(row(t, id(136))).toMatchObject({ onHand: 40, baseline: 40 });
		expect(row(t, id(170))).toBeUndefined();
		expect(row(t, "new-1")).toMatchObject({ onHand: 5, baseline: 5 });
		expect(row(t, id(34))).toMatchObject({ onHand: 4, baseline: 7 });

		const again = await syncAll(t);
		expect(again.at(-1)).toBe(
			"Checked all 250 products: added 0, reset 1 from product stock_quantity.",
		);
		expect(row(t, id(0))).toMatchObject({
			onHand: 30,
			baseline: 30,
			lastChange: { reason: "reset" },
		});
	});
});

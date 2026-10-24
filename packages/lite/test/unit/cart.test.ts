import { describe, expect, test } from "bun:test";
import {
	CART_HEADER,
	CART_TTL_MS,
	cartIdForToken,
	isValidToken,
	loadCart,
	mintToken,
	readToken,
} from "../../src/cart";
import {
	addItemHandler,
	clearCartHandler,
	getCartHandler,
	updateItemHandler,
} from "../../src/cart-routes";
import { makeCtx, product } from "../helpers/fake-ctx";

const h = (token: string | null) => (token ? { [CART_HEADER]: token } : {});

describe("cart token", () => {
	test("mints 43-char base64url tokens that validate", () => {
		const a = mintToken();
		const b = mintToken();
		expect(a).not.toBe(b);
		expect(isValidToken(a)).toBe(true);
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	test("rejects malformed tokens from headers", () => {
		expect(readToken({ [CART_HEADER]: "short" })).toBeNull();
		expect(readToken({ [CART_HEADER]: `${"a".repeat(42)}!` })).toBeNull();
		expect(readToken({})).toBeNull();
	});

	test("stores carts under the token hash, not the token", async () => {
		const { ctx, carts } = makeCtx({ products: [product("p1")] });
		const res = await addItemHandler(ctx, {}, { productId: "p1" });
		expect(res.ok).toBe(true);
		const token = (res as { token: string }).token;
		const id = await cartIdForToken(token);
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect([...carts.rows.keys()]).toEqual([id]);
		expect(JSON.stringify([...carts.rows.entries()])).not.toContain(token);
	});

	test("expired carts are dropped", async () => {
		const { ctx } = makeCtx({ products: [product("p1")] });
		const res = (await addItemHandler(ctx, {}, { productId: "p1" })) as { token: string };
		const id = await cartIdForToken(res.token);
		expect(await loadCart(ctx, id)).not.toBeNull();
		expect(await loadCart(ctx, id, Date.now() + CART_TTL_MS + 1000)).toBeNull();
	});
});

describe("cart routes", () => {
	test("GET without a token returns an empty cart and no token", async () => {
		const { ctx } = makeCtx();
		const res = await getCartHandler(ctx, {});
		expect(res).toMatchObject({ ok: true, token: null, cart: { items: [], currency: "USD" } });
	});

	test("add, merge, update and remove lines with server-side prices", async () => {
		const { ctx } = makeCtx({
			products: [product("p1"), product("p2", { prices: { USD: { amount: 250 } } })],
		});
		const first = (await addItemHandler(ctx, {}, { productId: "p1", quantity: 2, price: 1 })) as {
			token: string;
			cart: { items: Array<{ lineId: string }>; total: { amount: number } };
		};
		expect(first.cart.total.amount).toBe(3000);
		const token = first.token;

		const merged = (await addItemHandler(ctx, h(token), { productId: "p1" })) as typeof first;
		expect(merged.token).toBe(token);
		expect(merged.cart.items).toHaveLength(1);
		expect(merged.cart.total.amount).toBe(4500);

		const two = (await addItemHandler(ctx, h(token), {
			productId: "p2",
			quantity: 4,
		})) as typeof first;
		expect(two.cart.total.amount).toBe(5500);

		const lineId = two.cart.items[0]?.lineId as string;
		const updated = (await updateItemHandler(ctx, h(token), {
			lineId,
			quantity: 1,
		})) as typeof first;
		expect(updated.cart.total.amount).toBe(2500);

		const removed = (await updateItemHandler(ctx, h(token), {
			lineId,
			quantity: 0,
		})) as typeof first;
		expect(removed.cart.items).toHaveLength(1);
		expect(removed.cart.total.amount).toBe(1000);

		const fetched = await getCartHandler(ctx, h(token));
		expect(fetched.cart.total.amount).toBe(1000);

		const cleared = await clearCartHandler(ctx, h(token));
		expect(cleared.cart.items).toHaveLength(0);
	});

	test("an unknown but well-formed token starts a new cart under that token", async () => {
		const { ctx } = makeCtx({ products: [product("p1")] });
		const token = mintToken();
		const res = (await addItemHandler(ctx, h(token), { productId: "p1" })) as { token: string };
		expect(res.token).toBe(token);
	});

	test("validation and catalogue errors", async () => {
		const { ctx } = makeCtx({
			products: [
				product("oos", { stock_status: "outofstock" }),
				product("few", { manage_stock: 1, stock_quantity: 2 }),
				product("var", { type: "variable" }),
				product("eur", { prices: { EUR: { amount: 100 } } }),
				{ ...product("draft"), status: "draft" },
			],
		});
		const code = async (input: unknown) =>
			((await addItemHandler(ctx, {}, input)) as { error?: { code: string } }).error?.code;
		expect(await code({})).toBe("INVALID_INPUT");
		expect(await code({ productId: "../x" })).toBe("INVALID_INPUT");
		expect(await code({ productId: "few", quantity: 0 })).toBe("INVALID_INPUT");
		expect(await code({ productId: "few", quantity: 1.5 })).toBe("INVALID_INPUT");
		expect(await code({ productId: "missing" })).toBe("PRODUCT_NOT_FOUND");
		expect(await code({ productId: "draft" })).toBe("PRODUCT_NOT_FOUND");
		expect(await code({ productId: "oos" })).toBe("OUT_OF_STOCK");
		expect(await code({ productId: "few", quantity: 3 })).toBe("INSUFFICIENT_STOCK");
		expect(await code({ productId: "var" })).toBe("PRODUCT_TYPE_UNSUPPORTED");
		expect(await code({ productId: "eur" })).toBe("CURRENCY_NOT_PRICED");
	});

	test("updating a line without a cart fails cleanly", async () => {
		const { ctx } = makeCtx();
		const res = await updateItemHandler(ctx, h(mintToken()), { lineId: "x", quantity: 1 });
		expect(res).toMatchObject({ ok: false, error: { code: "CART_NOT_FOUND" } });
	});

	test("uses the configured store currency", async () => {
		const { ctx } = makeCtx({ settings: { currency: "eur" }, products: [product("p1")] });
		const res = (await addItemHandler(ctx, {}, { productId: "p1" })) as {
			cart: { currency: string; total: { amount: number } };
		};
		expect(res.cart.currency).toBe("EUR");
		expect(res.cart.total.amount).toBe(1400);
	});
});

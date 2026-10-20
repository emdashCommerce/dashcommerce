/**
 * Storefront cart handlers. Each returns plain JSON: `{ ok: true, ... }`
 * on success, `{ ok: false, error: { code, message } }` otherwise. The
 * route layer wraps that in EmDash's `{ success, data }` envelope.
 *
 * A successful response always carries the current `token`. A storefront
 * that had no token (or an expired one) gets a fresh token back from the
 * first `cart/items` call and should store it.
 */

import type { PluginContext } from "emdash/plugin";
import {
	CART_HEADER,
	cartIdForToken,
	emptyCart,
	loadCart,
	MAX_LINES,
	MAX_QUANTITY,
	mintToken,
	readToken,
	saveCart,
	toCartView,
} from "./cart";
import { priceProduct } from "./products";
import { readCurrency } from "./settings";
import { type CartLineItem, type CartState, money, randomId } from "./shared";
import { asId, asInt, asObject, fail } from "./validate";

export { CART_HEADER };

type Headers = Record<string, string>;

async function resolveCart(
	ctx: PluginContext,
	headers: Headers,
	opts: { create: boolean },
): Promise<{ token: string; cartId: string; cart: CartState; isNew: boolean } | null> {
	const currency = await readCurrency(ctx);
	const token = readToken(headers);
	if (token) {
		const cartId = await cartIdForToken(token);
		const cart = await loadCart(ctx.kv, cartId);
		if (cart) {
			// Store currency changed since this cart was created: start over
			// rather than mixing currencies.
			if (cart.currency !== currency) {
				return { token, cartId, cart: emptyCart(cartId, currency), isNew: false };
			}
			return { token, cartId, cart, isNew: false };
		}
		if (opts.create) return { token, cartId, cart: emptyCart(cartId, currency), isNew: false };
		return null;
	}
	if (!opts.create) return null;
	const fresh = mintToken();
	const cartId = await cartIdForToken(fresh);
	return { token: fresh, cartId, cart: emptyCart(cartId, currency), isNew: true };
}

export async function getCartHandler(ctx: PluginContext, headers: Headers) {
	const resolved = await resolveCart(ctx, headers, { create: false });
	if (!resolved) {
		const currency = await readCurrency(ctx);
		return { ok: true as const, token: null, cart: toCartView(emptyCart("", currency)) };
	}
	return { ok: true as const, token: resolved.token, cart: toCartView(resolved.cart) };
}

export async function addItemHandler(ctx: PluginContext, headers: Headers, input: unknown) {
	const body = asObject(input);
	const productId = asId(body.productId);
	if (!productId) return fail("INVALID_INPUT", "productId is required");
	const quantity = body.quantity === undefined ? 1 : asInt(body.quantity, 1, MAX_QUANTITY);
	if (quantity === undefined) {
		return fail("INVALID_INPUT", `quantity must be an integer from 1 to ${MAX_QUANTITY}`);
	}

	const resolved = await resolveCart(ctx, headers, { create: true });
	if (!resolved) return fail("CART_UNAVAILABLE", "Could not open a cart");
	const { token, cart } = resolved;

	const existing = cart.items.find((i) => i.productId === productId);
	const nextQty = (existing?.quantity ?? 0) + quantity;
	if (nextQty > MAX_QUANTITY) {
		return fail("INVALID_INPUT", `At most ${MAX_QUANTITY} of one product per order`);
	}
	if (!existing && cart.items.length >= MAX_LINES) {
		return fail("CART_FULL", `A cart can hold at most ${MAX_LINES} different products`);
	}

	const priced = await priceProduct(ctx, productId, cart.currency, nextQty);
	if (!priced.ok) return fail(priced.code, priced.message);
	const { product } = priced;

	let items: CartLineItem[];
	if (existing) {
		items = cart.items.map((i) =>
			i === existing ? withQuantity({ ...i, unitPrice: product.unitPrice }, nextQty) : i,
		);
	} else {
		const line: CartLineItem = {
			lineId: randomId(),
			productId: product.id,
			quantity: nextQty,
			unitPrice: product.unitPrice,
			lineSubtotal: money(product.unitPrice.currency, product.unitPrice.amount * nextQty),
			title: product.title,
			isDigital: product.fields.isVirtual || product.fields.isDownloadable,
		};
		items = [...cart.items, line];
	}
	const saved = await saveCart(ctx.kv, { ...cart, items });
	return { ok: true as const, token, cart: toCartView(saved) };
}

export async function updateItemHandler(ctx: PluginContext, headers: Headers, input: unknown) {
	const body = asObject(input);
	const lineId = asId(body.lineId);
	const quantity = asInt(body.quantity, 0, MAX_QUANTITY);
	if (!lineId || quantity === undefined) {
		return fail("INVALID_INPUT", `lineId and quantity (0 to ${MAX_QUANTITY}) are required`);
	}
	const resolved = await resolveCart(ctx, headers, { create: false });
	if (!resolved) return fail("CART_NOT_FOUND", "No cart for this token");
	const { token, cart } = resolved;
	const line = cart.items.find((i) => i.lineId === lineId);
	if (!line) return fail("LINE_NOT_FOUND", "No such line in this cart");

	let items: CartLineItem[];
	if (quantity === 0) {
		items = cart.items.filter((i) => i !== line);
	} else {
		// Re-check stock and price for the new quantity.
		const priced = await priceProduct(ctx, line.productId, cart.currency, quantity);
		if (!priced.ok) return fail(priced.code, priced.message);
		items = cart.items.map((i) =>
			i === line ? withQuantity({ ...i, unitPrice: priced.product.unitPrice }, quantity) : i,
		);
	}
	const saved = await saveCart(ctx.kv, { ...cart, items });
	return { ok: true as const, token, cart: toCartView(saved) };
}

export async function clearCartHandler(ctx: PluginContext, headers: Headers) {
	const resolved = await resolveCart(ctx, headers, { create: false });
	const currency = await readCurrency(ctx);
	if (!resolved)
		return { ok: true as const, token: null, cart: toCartView(emptyCart("", currency)) };
	const saved = await saveCart(ctx.kv, emptyCart(resolved.cartId, currency));
	return { ok: true as const, token: resolved.token, cart: toCartView(saved) };
}

function withQuantity(line: CartLineItem, quantity: number): CartLineItem {
	return {
		...line,
		quantity,
		lineSubtotal: money(line.unitPrice.currency, line.unitPrice.amount * quantity),
	};
}

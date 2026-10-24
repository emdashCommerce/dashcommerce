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
	priceCart,
	readToken,
	saveCart,
	toCartView,
} from "./cart";
import { priceProduct } from "./products";
import { type LiteConfig, loadConfig } from "./settings";
import { type CartLineItem, type CartState, money, randomId } from "./shared";
import { asId, asInt, asObject, fail } from "./validate";

export { CART_HEADER };

type Headers = Record<string, string>;

type Resolved = {
	token: string;
	cartId: string;
	cart: CartState;
	config: LiteConfig;
};

/** Settings plus the cart for the token: 1 or 2 bridge calls. */
async function resolveCart(
	ctx: PluginContext,
	headers: Headers,
	opts: { create: boolean },
): Promise<{ config: LiteConfig; resolved: Resolved | null }> {
	const config = await loadConfig(ctx);
	const currency = config.currency;
	const token = readToken(headers);
	if (token) {
		const cartId = await cartIdForToken(token);
		const cart = await loadCart(ctx, cartId);
		if (cart) {
			// Store currency changed since this cart was created: start over
			// rather than mixing currencies.
			const usable = cart.currency === currency ? cart : emptyCart(cartId, currency);
			return { config, resolved: { token, cartId, cart: usable, config } };
		}
		if (opts.create) {
			return { config, resolved: { token, cartId, cart: emptyCart(cartId, currency), config } };
		}
		return { config, resolved: null };
	}
	if (!opts.create) return { config, resolved: null };
	const fresh = mintToken();
	const cartId = await cartIdForToken(fresh);
	return {
		config,
		resolved: { token: fresh, cartId, cart: emptyCart(cartId, currency), config },
	};
}

export async function getCartHandler(ctx: PluginContext, headers: Headers) {
	const { config, resolved } = await resolveCart(ctx, headers, { create: false });
	if (!resolved) {
		return {
			ok: true as const,
			token: null,
			cart: toCartView(emptyCart("", config.currency), config),
		};
	}
	return {
		ok: true as const,
		token: resolved.token,
		cart: toCartView(priceCartForView(resolved), config),
	};
}

export async function addItemHandler(ctx: PluginContext, headers: Headers, input: unknown) {
	const body = asObject(input);
	const productId = asId(body.productId);
	if (!productId) return fail("INVALID_INPUT", "productId is required");
	const quantity = body.quantity === undefined ? 1 : asInt(body.quantity, 1, MAX_QUANTITY);
	if (quantity === undefined) {
		return fail("INVALID_INPUT", `quantity must be an integer from 1 to ${MAX_QUANTITY}`);
	}

	const { resolved } = await resolveCart(ctx, headers, { create: true });
	if (!resolved) return fail("CART_UNAVAILABLE", "Could not open a cart");
	const { token, cart, config } = resolved;

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
	const saved = await saveCart(ctx, { ...cart, items }, config);
	return { ok: true as const, token, cart: toCartView(saved, config) };
}

export async function updateItemHandler(ctx: PluginContext, headers: Headers, input: unknown) {
	const body = asObject(input);
	const lineId = asId(body.lineId);
	const quantity = asInt(body.quantity, 0, MAX_QUANTITY);
	if (!lineId || quantity === undefined) {
		return fail("INVALID_INPUT", `lineId and quantity (0 to ${MAX_QUANTITY}) are required`);
	}
	const { resolved } = await resolveCart(ctx, headers, { create: false });
	if (!resolved) return fail("CART_NOT_FOUND", "No cart for this token");
	const { token, cart, config } = resolved;
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
	const saved = await saveCart(ctx, { ...cart, items }, config);
	return { ok: true as const, token, cart: toCartView(saved, config) };
}

export async function clearCartHandler(ctx: PluginContext, headers: Headers) {
	const { config, resolved } = await resolveCart(ctx, headers, { create: false });
	if (!resolved) {
		return {
			ok: true as const,
			token: null,
			cart: toCartView(emptyCart("", config.currency), config),
		};
	}
	const saved = await saveCart(ctx, emptyCart(resolved.cartId, config.currency), config);
	return { ok: true as const, token: resolved.token, cart: toCartView(saved, config) };
}

/** Show totals under the current shipping and tax settings without a write. */
function priceCartForView(r: Resolved): CartState {
	return priceCart(r.cart, r.config);
}

function withQuantity(line: CartLineItem, quantity: number): CartLineItem {
	return {
		...line,
		quantity,
		lineSubtotal: money(line.unitPrice.currency, line.unitPrice.amount * quantity),
	};
}

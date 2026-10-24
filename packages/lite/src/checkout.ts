/**
 * Stripe hosted Checkout.
 *
 * `checkout/session` re-prices every cart line from the products
 * collection (the stored cart price is never trusted), checks stock
 * against the stock ledger, writes a pending order, then creates a Stripe
 * Checkout Session with core's `createCheckoutSession()` and returns its
 * URL. The storefront redirects the shopper there. Payment is confirmed
 * only by the signed webhook, which also takes the items out of stock.
 *
 * Subrequest budget (budget.ts): a request makes at most 8 bridge calls.
 * Settings 1, cart 1, then the product reads, then stock ledger 1, order
 * lookup 1, order create 1, the Stripe request 1 and the order update 1.
 * That leaves 1 call for products: one `content.get`, or one
 * `content.list` page that covers a shop of up to 100 published products
 * (products.ts). When a cart needs more reads, the request reads as many
 * as fit (up to 5), stores them on the cart record (`checkoutPrep`,
 * trusted for 5 minutes and only for this cart version) and answers
 * `CHECKOUT_CONTINUE`; the storefront kit sends the request again and the
 * next one picks up where it stopped. A 20-line cart needs at most 5
 * requests in the worst case, and 1 in a shop of up to 100 products.
 *
 * Double submits: the order id and the Stripe idempotency key derive from
 * the cart id and the cart's `updatedAt`, so checking out the same cart
 * twice reuses the pending order and Stripe replays the same session. If
 * that attempt failed or was cancelled, the next of 5 attempt ids is used
 * (all 5 are read in one `getMany`). Any cart change gives new attempts.
 */

import type { PluginContext } from "emdash/plugin";
import { log, metered, remaining } from "./budget";
import {
	cartIdForToken,
	cartsStore,
	loadStoredCart,
	priceCart,
	readToken,
	saveCart,
	sha256Hex,
	toCartView,
} from "./cart";
import {
	isAwaitingAsyncPayment,
	type LiteOrder,
	type LiteOrderItem,
	newOrderNumber,
	ordersStore,
} from "./orders";
import {
	evaluateProduct,
	type LoadedProduct,
	loadProducts,
	newProductLoad,
	type ProductLoad,
} from "./products";
import { buildReturnUrl, loadConfig } from "./settings";
import {
	type CartLineItem,
	type CheckoutLineItem,
	createCheckoutSession,
	type CreateCheckoutSessionInput,
	money,
	randomId,
	StripeApiError,
} from "./shared";
import { isTracked, type StockRow, stockStore } from "./stock";
import { asEmail, asObject, fail } from "./validate";

export const STRIPE_METADATA_SOURCE = "dashcommerce-lite";

/** How long product reads stored on the cart by an earlier request stay trusted. */
export const PREP_TTL_MS = 5 * 60 * 1000;
/** Attempt ids per cart version (see the header). */
export const CHECKOUT_ATTEMPTS = 5;
/**
 * Calls a final checkout request needs after the product reads: stock
 * ledger, order lookup, order create, Stripe, order update.
 */
const FINAL_CALLS = 5;

/** Order id and Stripe idempotency key for one checkout of one cart version. */
export async function checkoutAttempt(cartId: string, cartUpdatedAt: string, attempt = 0) {
	const suffix = attempt === 0 ? "" : `#${attempt}`;
	const hash = await sha256Hex(`checkout:${cartId}:${cartUpdatedAt}${suffix}`);
	return { orderId: hash.slice(0, 32), idempotencyKey: `dc_checkout_${hash.slice(0, 48)}` };
}

const CONTINUE = () =>
	fail("CHECKOUT_CONTINUE", "Still checking the cart. Send the checkout request again.");

export async function createCheckoutHandler(
	rawCtx: PluginContext,
	headers: Record<string, string>,
	input: unknown,
	now = Date.now(),
) {
	const ctx = metered(rawCtx);
	const body = asObject(input);
	const email = body.email === undefined ? undefined : asEmail(body.email);
	if (body.email !== undefined && !email) return fail("INVALID_INPUT", "email is not valid");

	const config = await loadConfig(ctx);
	const secretKey = config.stripeSecretKey;
	if (!secretKey) return fail("STRIPE_NOT_CONFIGURED", "Stripe is not configured for this shop");

	const token = readToken(headers);
	if (!token) return fail("CART_NOT_FOUND", "No cart token sent");
	const cartId = await cartIdForToken(token);
	const stored = await loadStoredCart(ctx, cartId, now);
	const cart = stored?.cart;
	if (!stored || !cart || cart.items.length === 0) return fail("CART_EMPTY", "The cart is empty");

	if (cart.currency !== config.currency) {
		await saveCart(ctx, { ...cart, items: [], currency: config.currency }, config);
		return fail("CART_CURRENCY_CHANGED", "The shop currency changed. The cart was emptied.");
	}

	// Re-price from the source of truth. Products an earlier request of
	// this checkout already read (same cart version, recent) are reused.
	const prep =
		stored.checkoutPrep?.cartUpdatedAt === cart.updatedAt ? stored.checkoutPrep.products : {};
	const known = new Map<string, LoadedProduct>();
	for (const [id, p] of Object.entries(prep)) {
		if (now - Date.parse(p.at) < PREP_TTL_MS) known.set(id, { id, fields: p.fields });
	}
	// One list page only on the first request of a checkout; a follow-up
	// request reads what is left one by one.
	const load = newProductLoad(
		cart.items.map((l) => l.productId).filter((id) => !known.has(id)),
		!stored.checkoutPrep || stored.checkoutPrep.cartUpdatedAt !== cart.updatedAt,
	);
	await loadProducts(ctx, load, remaining(ctx) - FINAL_CALLS);
	if (load.missing.size === 0 && load.pending.length > 0) {
		// Too many to read in one request: read what fits now.
		await loadProducts(ctx, load, remaining(ctx) - 1);
	}
	const errors: Array<{ lineId: string; code: string; message: string }> = [];
	if (load.missing.size > 0) {
		for (const line of cart.items) {
			if (!load.missing.has(line.productId)) continue;
			errors.push({
				lineId: line.lineId,
				code: "PRODUCT_NOT_FOUND",
				message: "Product not found or unavailable",
			});
		}
		return fail("CART_INVALID", "Some items cannot be bought", { errors });
	}
	if (load.pending.length > 0 || remaining(ctx) < FINAL_CALLS) {
		// Keep what was read on the cart record and let the storefront call
		// again; the next request reads the rest and finishes.
		await savePrep(ctx, cartId, stored, known, load, now);
		return CONTINUE();
	}
	for (const [id, p] of load.found) known.set(id, p);

	const loaded: Array<{ line: CartLineItem; product: LoadedProduct }> = [];
	for (const line of cart.items) {
		const product = known.get(line.productId);
		if (product) loaded.push({ line, product });
	}
	const trackedIds = loaded.filter((l) => isTracked(l.product.fields)).map((l) => l.product.id);
	const rows =
		trackedIds.length > 0 ? await stockStore(ctx).getMany(trackedIds) : new Map<string, StockRow>();

	const items: CartLineItem[] = [];
	const orderItems: LiteOrderItem[] = [];
	for (const { line, product } of loaded) {
		const priced = evaluateProduct(product, cart.currency, line.quantity, rows.get(product.id));
		if (!priced.ok) {
			errors.push({ lineId: line.lineId, code: priced.code, message: priced.message });
			continue;
		}
		const p = priced.product;
		const lineSubtotal = money(p.unitPrice.currency, p.unitPrice.amount * line.quantity);
		// Digital or physical comes from the product, not the stored cart line.
		const isDigital = Boolean(p.fields.isVirtual || p.fields.isDownloadable);
		items.push({ ...line, title: p.title, unitPrice: p.unitPrice, lineSubtotal, isDigital });
		orderItems.push({
			productId: p.id,
			title: p.title,
			quantity: line.quantity,
			unitPrice: p.unitPrice,
			lineTotal: lineSubtotal,
			...(p.stock ? { stock: { baseline: p.stock.baseline, backorders: p.stock.backorders } } : {}),
		});
	}
	if (errors.length > 0) return fail("CART_INVALID", "Some items cannot be bought", { errors });

	// Totals under the current shipping and tax settings. A changed total
	// (price, shipping or tax) goes back to the shopper for review.
	const repriced = priceCart({ ...cart, items }, config);
	if (repriced.total.amount !== cart.total.amount) {
		const saved = await saveCart(ctx, repriced, config);
		return fail("CART_CHANGED", "Prices changed. Review the cart and try again.", {
			cart: toCartView(saved, config),
		});
	}
	if (repriced.total.amount <= 0) return fail("INVALID_TOTAL", "Order total must be positive");

	const at = new Date(now).toISOString();
	const fresh: LiteOrder = {
		orderNumber: newOrderNumber(now),
		orderKey: randomId(),
		cartId,
		status: "pending",
		paymentStatus: "pending",
		currency: repriced.currency,
		items: orderItems,
		subtotal: repriced.subtotal,
		shippingTotal: repriced.shippingTotal,
		taxTotal: repriced.taxTotal,
		total: repriced.total,
		...(config.automaticTax ? { automaticTax: true } : {}),
		...(email ? { customerEmail: email.toLowerCase() } : {}),
		createdAt: at,
		updatedAt: at,
	};

	// Pick the attempt: reuse a pending order for this cart version (double
	// submit), skip failed or cancelled ones, stop if one was paid.
	const attempts = await Promise.all(
		Array.from({ length: CHECKOUT_ATTEMPTS }, (_, n) => checkoutAttempt(cartId, cart.updatedAt, n)),
	);
	const orders = ordersStore(ctx);
	const existing = await orders.getMany(attempts.map((a) => a.orderId));
	let chosen: { orderId: string; idempotencyKey: string; order: LiteOrder | null } | null = null;
	for (const a of attempts) {
		const ex = existing.get(a.orderId);
		if (!ex) {
			chosen = { ...a, order: null };
			break;
		}
		if (ex.paidAt || isAwaitingAsyncPayment(ex)) {
			return fail("CHECKOUT_COMPLETE", "This cart was already checked out");
		}
		if (ex.status === "pending" && ex.paymentStatus === "pending") {
			// Same cart, same version: a double submit. Reuse the order so the
			// Stripe request is identical and Stripe replays the same session.
			chosen = { ...a, order: ex };
			break;
		}
	}
	if (!chosen) {
		// Every attempt for this cart version failed: start a new version.
		await saveCart(ctx, repriced, config);
		return CONTINUE();
	}
	const { orderId, idempotencyKey } = chosen;
	const order = chosen.order ?? fresh;
	if (!chosen.order && !(await orders.compareAndSet(orderId, null, fresh)).applied) {
		// A concurrent request created it first; the next request reuses it.
		return CONTINUE();
	}
	const orderKey = order.orderKey;

	const vars = { ORDER_ID: orderId, ORDER_KEY: orderKey };
	const metadata = { orderId, orderNumber: order.orderNumber, source: STRIPE_METADATA_SOURCE };
	const hasPhysical = repriced.items.some((i) => !i.isDigital);
	const lineItems: CheckoutLineItem[] = repriced.items.map((i) => ({
		amount: i.unitPrice.amount,
		currency: i.unitPrice.currency,
		name: i.title || "Product",
		quantity: i.quantity,
		metadata: { productId: i.productId },
		...(config.automaticTax ? { taxBehavior: "exclusive" as const } : {}),
	}));
	// Flat tax goes to Stripe as its own line so the hosted page total
	// matches the order total.
	if (repriced.taxTotal.amount > 0) {
		lineItems.push({
			amount: repriced.taxTotal.amount,
			currency: repriced.currency,
			name: `Tax (${config.flatTaxPercent}%)`,
			quantity: 1,
			metadata: { kind: "tax" },
		});
	}
	const sessionInput: CreateCheckoutSessionInput = {
		mode: "payment",
		successUrl: buildReturnUrl(config.successUrl, ctx.site.url, vars),
		cancelUrl: buildReturnUrl(config.cancelUrl, ctx.site.url, vars),
		lineItems,
		clientReferenceId: orderId,
		metadata,
		paymentIntentMetadata: metadata,
		...(email ? { customerEmail: email } : {}),
		...(hasPhysical && config.shippingCountries.length > 0
			? { shippingAddressCollection: { allowedCountries: config.shippingCountries } }
			: {}),
		...(repriced.shippingTotal.amount > 0
			? {
					shippingOptions: [
						{
							displayName: "Shipping",
							amount: repriced.shippingTotal.amount,
							currency: repriced.currency,
							...(config.automaticTax ? { taxBehavior: "exclusive" as const } : {}),
						},
					],
				}
			: {}),
		...(config.automaticTax ? { automaticTax: true } : {}),
	};

	try {
		// The cast bridges core's `emdash` PluginContext type to the
		// `emdash/plugin` one; at runtime it only uses `ctx.http`.
		const session = await createCheckoutSession(
			ctx as unknown as Parameters<typeof createCheckoutSession>[0],
			sessionInput,
			{ secretKey },
			idempotencyKey,
		);
		if (!session.url) throw new Error("Stripe returned no Checkout URL");
		await orders.put(orderId, { ...order, stripeSessionId: session.id });
		return {
			ok: true as const,
			orderId,
			orderKey,
			orderNumber: order.orderNumber,
			url: session.url,
		};
	} catch (err) {
		await orders.put(orderId, { ...order, status: "failed", paymentStatus: "failed" });
		if (err instanceof StripeApiError) {
			log(ctx, "error", "Stripe Checkout Session creation failed", { status: err.status });
			return fail("STRIPE_ERROR", "Payment provider rejected the checkout request");
		}
		log(ctx, "error", "Checkout failed", {
			message: err instanceof Error ? err.message : "unknown",
		});
		return fail("CHECKOUT_FAILED", "Could not start checkout");
	}
}

/** Keep the products read so far on the cart record for the next request. One call. */
async function savePrep(
	ctx: PluginContext,
	cartId: string,
	stored: NonNullable<Awaited<ReturnType<typeof loadStoredCart>>>,
	known: Map<string, LoadedProduct>,
	load: ProductLoad,
	now: number,
) {
	const at = new Date(now).toISOString();
	const previous = stored.checkoutPrep?.products ?? {};
	const products: Record<string, { fields: LoadedProduct["fields"]; at: string }> = {};
	for (const [id, p] of known) products[id] = { fields: p.fields, at: previous[id]?.at ?? at };
	for (const [id, p] of load.found) products[id] = { fields: p.fields, at };
	await cartsStore(ctx).put(cartId, {
		...stored,
		checkoutPrep: { cartUpdatedAt: stored.cart.updatedAt, products },
	});
}

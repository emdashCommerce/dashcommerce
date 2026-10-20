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
 * Bridge calls per checkout: settings 1, cart 1, one content read per
 * line, stock ledger 1 (only when a line tracks stock), order writes 2,
 * plus the Stripe request. That is 6 + lines, or 26 at the 20-line cap.
 * See DESIGN.md, "Cloudflare limits".
 */

import type { PluginContext } from "emdash/plugin";
import { cartIdForToken, loadCart, priceCart, readToken, saveCart, toCartView } from "./cart";
import { type LiteOrder, type LiteOrderItem, newOrderNumber, ordersStore } from "./orders";
import { evaluateProduct, type LoadedProduct, loadProduct } from "./products";
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

export const STRIPE_METADATA_SOURCE = "dashcommerce";

export async function createCheckoutHandler(
	ctx: PluginContext,
	headers: Record<string, string>,
	input: unknown,
) {
	const body = asObject(input);
	const email = body.email === undefined ? undefined : asEmail(body.email);
	if (body.email !== undefined && !email) return fail("INVALID_INPUT", "email is not valid");

	const config = await loadConfig(ctx);
	const secretKey = config.stripeSecretKey;
	if (!secretKey) return fail("STRIPE_NOT_CONFIGURED", "Stripe is not configured for this shop");

	const token = readToken(headers);
	if (!token) return fail("CART_NOT_FOUND", "No cart token sent");
	const cartId = await cartIdForToken(token);
	const cart = await loadCart(ctx, cartId);
	if (!cart || cart.items.length === 0) return fail("CART_EMPTY", "The cart is empty");

	if (cart.currency !== config.currency) {
		await saveCart(ctx, { ...cart, items: [], currency: config.currency }, config);
		return fail("CART_CURRENCY_CHANGED", "The shop currency changed. The cart was emptied.");
	}

	// Re-price from the source of truth: one content read per line, then
	// one batched ledger read for the lines that track stock.
	const errors: Array<{ lineId: string; code: string; message: string }> = [];
	const loaded: Array<{ line: CartLineItem; product: LoadedProduct }> = [];
	for (const line of cart.items) {
		const product = await loadProduct(ctx, line.productId);
		if ("ok" in product) {
			errors.push({ lineId: line.lineId, code: product.code, message: product.message });
		} else {
			loaded.push({ line, product });
		}
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
		items.push({ ...line, title: p.title, unitPrice: p.unitPrice, lineSubtotal });
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

	const orderId = randomId();
	const orderKey = randomId();
	const now = new Date().toISOString();
	const order: LiteOrder = {
		orderNumber: newOrderNumber(),
		orderKey,
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
		createdAt: now,
		updatedAt: now,
	};
	const orders = ordersStore(ctx);
	await orders.put(orderId, order);

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
			`dc_checkout_${orderId}`,
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
			ctx.log.error("Stripe Checkout Session creation failed", { status: err.status });
			return fail("STRIPE_ERROR", "Payment provider rejected the checkout request");
		}
		ctx.log.error("Checkout failed", { message: err instanceof Error ? err.message : "unknown" });
		return fail("CHECKOUT_FAILED", "Could not start checkout");
	}
}

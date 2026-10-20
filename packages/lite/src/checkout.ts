/**
 * Stripe hosted Checkout.
 *
 * `checkout/session` re-prices every cart line from the products
 * collection (the stored cart price is never trusted), writes a pending
 * order, then creates a Stripe Checkout Session with core's
 * `createCheckoutSession()` and returns its URL. The storefront redirects
 * the shopper there. Payment is confirmed only by the signed webhook.
 */

import type { PluginContext } from "emdash/plugin";
import { cartIdForToken, loadCart, readToken, saveCart, toCartView } from "./cart";
import { type LiteOrder, newOrderNumber, ordersStore } from "./orders";
import { priceProduct } from "./products";
import { buildReturnUrl, readSettings } from "./settings";
import {
	type CartLineItem,
	createCheckoutSession,
	type CreateCheckoutSessionInput,
	money,
	randomId,
	recalculate,
	StripeApiError,
} from "./shared";
import { asEmail, asObject, fail } from "./validate";

export async function createCheckoutHandler(
	ctx: PluginContext,
	headers: Record<string, string>,
	input: unknown,
) {
	const body = asObject(input);
	const email = body.email === undefined ? undefined : asEmail(body.email);
	if (body.email !== undefined && !email) return fail("INVALID_INPUT", "email is not valid");

	const secretKey = await ctx.settings.get<string>("stripeSecretKey");
	if (!secretKey) return fail("STRIPE_NOT_CONFIGURED", "Stripe is not configured for this shop");

	const token = readToken(headers);
	if (!token) return fail("CART_NOT_FOUND", "No cart token sent");
	const cartId = await cartIdForToken(token);
	const cart = await loadCart(ctx.kv, cartId);
	if (!cart || cart.items.length === 0) return fail("CART_EMPTY", "The cart is empty");

	const settings = await readSettings(ctx);
	if (cart.currency !== settings.currency) {
		await saveCart(ctx.kv, { ...cart, items: [], currency: settings.currency });
		return fail("CART_CURRENCY_CHANGED", "The shop currency changed. The cart was emptied.");
	}

	// Re-price from the source of truth.
	const errors: Array<{ lineId: string; code: string; message: string }> = [];
	const items: CartLineItem[] = [];
	for (const line of cart.items) {
		const priced = await priceProduct(ctx, line.productId, cart.currency, line.quantity);
		if (!priced.ok) {
			errors.push({ lineId: line.lineId, code: priced.code, message: priced.message });
			continue;
		}
		const unit = priced.product.unitPrice;
		items.push({
			...line,
			title: priced.product.title,
			unitPrice: unit,
			lineSubtotal: money(unit.currency, unit.amount * line.quantity),
		});
	}
	if (errors.length > 0) return fail("CART_INVALID", "Some items cannot be bought", { errors });

	const repriced = recalculate({ ...cart, items });
	if (repriced.total.amount !== cart.total.amount) {
		const saved = await saveCart(ctx.kv, repriced);
		return fail("CART_CHANGED", "Prices changed. Review the cart and try again.", {
			cart: toCartView(saved),
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
		items: repriced.items.map((i) => ({
			productId: i.productId,
			title: i.title,
			quantity: i.quantity,
			unitPrice: i.unitPrice,
			lineTotal: i.lineSubtotal,
		})),
		subtotal: repriced.subtotal,
		total: repriced.total,
		...(email ? { customerEmail: email } : {}),
		createdAt: now,
		updatedAt: now,
	};
	const orders = ordersStore(ctx);
	await orders.put(orderId, order);

	const vars = { ORDER_ID: orderId, ORDER_KEY: orderKey };
	const metadata = { orderId, orderNumber: order.orderNumber, source: "dashcommerce-lite" };
	const hasPhysical = repriced.items.some((i) => !i.isDigital);
	const sessionInput: CreateCheckoutSessionInput = {
		mode: "payment",
		successUrl: buildReturnUrl(settings.successUrl, ctx.site.url, vars),
		cancelUrl: buildReturnUrl(settings.cancelUrl, ctx.site.url, vars),
		lineItems: repriced.items.map((i) => ({
			amount: i.unitPrice.amount,
			currency: i.unitPrice.currency,
			name: i.title || "Product",
			quantity: i.quantity,
			metadata: { productId: i.productId },
		})),
		clientReferenceId: orderId,
		metadata,
		paymentIntentMetadata: metadata,
		...(email ? { customerEmail: email } : {}),
		...(hasPhysical && settings.shippingCountries.length > 0
			? { shippingAddressCollection: { allowedCountries: settings.shippingCountries } }
			: {}),
	};

	try {
		// The cast bridges core's `emdash` PluginContext type to the
		// `emdash/plugin` one; at runtime it only uses `ctx.http`.
		const session = await createCheckoutSession(
			ctx as unknown as Parameters<typeof createCheckoutSession>[0],
			sessionInput,
			{ secretKey },
			`dcl_checkout_${orderId}`,
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

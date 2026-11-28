/**
 * Public checkout routes.
 *
 *   POST /checkout/create-intent
 *      body: { customerEmail?, notes? }
 *      auth: session cookie from /cart flow
 *      → creates a Stripe PaymentIntent, reserves stock via soft-locks,
 *        persists a cart snapshot keyed by orderDraftId so the webhook
 *        can replay it on payment_intent.succeeded.
 *      → { clientSecret, orderDraftId, paymentIntentId }
 *
 * Critical: we re-price the cart server-side against current product &
 * variant data. The `unit_price` + `lineSubtotal` on the client-submitted
 * cart are recomputed from source. Inventory availability is checked
 * against `stockQuantity − sumActiveLocksForProduct`.
 */

import type { PluginContext, RouteContext } from "emdash";
import { type PricingPolicy, recalculate } from "../cart/calculate";
import { createLock, newLock, sumActiveLocksForProduct } from "../cart/lock";
import { getCart, save } from "../cart/store";
import { refreshAppliedCoupons } from "../coupons/refresh";
import { money, zero } from "../money";
import {
	DEFAULT_PAYMENT_PROVIDER_ID,
	type InitCheckoutInput,
	type PaymentProviderSplitAllocation,
	loadPaymentProviderCredentials,
	providerCheckoutStyles,
	resolveProvider,
	unsupportedHostedCheckoutFeatures,
} from "../payment-provider";
import { normalizeProductFields } from "../products/normalize";
import { resolvePrice } from "../products/pricing";
import { isVariantOfProduct } from "../products/variant-guard";
import { getVariant } from "../products/variants";
import { type CheckoutMode, DEFAULT_CHECKOUT_MODE } from "../settings/schema";
import { requoteShipping } from "../shipping/requote";
import {
	type CheckoutLineItem,
	type CheckoutShippingOption,
	createOneTimeCoupon,
} from "../stripe/checkout-sessions";
import type { StripeClientOptions } from "../stripe/client";
import { createPaymentIntent } from "../stripe/payment-intents";
import type { CartLineItem, CartState, StockLockEntry } from "../types";
import { randomId } from "../util/ids";
import { getPublicSiteUrl } from "../util/site-url";
import { computeProviderSplit } from "../vendors/provider-split";
import { computeSplit, connectEnabled } from "../vendors/split";
import { resolveSessionId } from "./cart";

const DRAFT_PREFIX = "draft:";
const DRAFT_TTL_MS = 15 * 60 * 1000;
const LOCK_TTL_MS = 15 * 60 * 1000;

async function readPricingPolicy(ctx: PluginContext): Promise<PricingPolicy> {
	const mode = (await ctx.kv.get<string>("settings:taxMode")) ?? "flat";
	const pct = (await ctx.kv.get<number>("settings:flatTaxRatePercent")) ?? 0;
	const onShipping = (await ctx.kv.get<boolean>("settings:taxAppliesToShipping")) ?? false;
	const policy: PricingPolicy = {
		taxMode: mode === "table" ? "table" : mode === "stripe_tax" ? "stripe_tax" : "flat",
		taxAppliesToShipping: onShipping,
	};
	if (policy.taxMode === "flat") policy.flatTaxPercent = pct;
	return policy;
}

async function loadStripeClient(ctx: PluginContext): Promise<StripeClientOptions | null> {
	const secret = await ctx.kv.get<string>("settings:stripeSecretKey");
	if (!secret) return null;
	return { secretKey: secret };
}

interface RepriceError {
	lineId: string;
	productId: string;
	reason: string;
}

interface RepriceResult {
	items: CartLineItem[];
	errors: RepriceError[];
	stockEntries: StockLockEntry[];
}

async function repriceAndCheckStock(ctx: PluginContext, cart: CartState): Promise<RepriceResult> {
	const errors: RepriceError[] = [];
	const out: CartLineItem[] = [];
	const stockEntries: StockLockEntry[] = [];

	if (!ctx.content) {
		return {
			items: cart.items,
			errors: [
				{
					lineId: "*",
					productId: "*",
					reason: "content access unavailable — cannot re-price",
				},
			],
			stockEntries,
		};
	}

	for (const line of cart.items) {
		const record = await ctx.content.get("products", line.productId);
		if (!record || record.status !== "published") {
			errors.push({ lineId: line.lineId, productId: line.productId, reason: "unavailable" });
			continue;
		}
		const fields = normalizeProductFields(record.data as Record<string, unknown>);
		const variant = line.variantId ? await getVariant(ctx, line.variantId) : null;
		if (line.variantId) {
			if (!isVariantOfProduct(variant, record.id)) {
				errors.push({
					lineId: line.lineId,
					productId: line.productId,
					reason: "invalid variant for product",
				});
				continue;
			}
		}
		const priced = resolvePrice({ product: fields, variant, currency: cart.currency });
		if (!priced) {
			errors.push({
				lineId: line.lineId,
				productId: line.productId,
				reason: `not priced in ${cart.currency}`,
			});
			continue;
		}

		// Availability: stockStatus + manageStock + locked units
		if (fields.stockStatus === "outofstock" && fields.backorders !== "yes") {
			errors.push({
				lineId: line.lineId,
				productId: line.productId,
				reason: "out of stock",
			});
			continue;
		}

		// Stock quantity check: subtract active locks (excluding this session's own soft-hold).
		const tracked =
			(variant && variant.stockQuantity !== null) ||
			(fields.manageStock && fields.stockQuantity !== null);
		if (tracked) {
			const onHand = variant?.stockQuantity ?? fields.stockQuantity ?? 0;
			const locked = await sumActiveLocksForProduct(
				ctx,
				line.productId,
				line.variantId ?? undefined,
			);
			const available = onHand - locked;
			if (line.quantity > available && fields.backorders === "no") {
				errors.push({
					lineId: line.lineId,
					productId: line.productId,
					reason: `only ${Math.max(0, available)} available`,
				});
				continue;
			}
		}

		const repriced: CartLineItem = {
			...line,
			unitPrice: priced.unit,
			lineSubtotal: money(priced.unit.currency, priced.unit.amount * line.quantity),
			title: fields.title,
			isDigital: fields.isVirtual || fields.isDownloadable,
		};
		out.push(repriced);

		if (tracked) {
			stockEntries.push({
				productId: line.productId,
				...(line.variantId ? { variantId: line.variantId } : {}),
				quantity: line.quantity,
			});
		}
	}

	return { items: out, errors, stockEntries };
}

function totalsChanged(before: CartState, after: CartState): boolean {
	return (
		before.total.amount !== after.total.amount ||
		before.subtotal.amount !== after.subtotal.amount ||
		before.discountTotal.amount !== after.discountTotal.amount ||
		before.shippingTotal.amount !== after.shippingTotal.amount ||
		before.taxTotal.amount !== after.taxTotal.amount
	);
}

/**
 * After server-side reprice + stock check: refresh coupons, re-quote
 * shipping, and recalculate. Returns the corrected cart. Callers that
 * observe a totals drift vs the pre-check cart should 409 with the
 * corrected cart so the client can confirm before charging.
 */
async function finalizeCheckoutCart(
	ctx: PluginContext,
	cart: CartState,
	repricedItems: CartLineItem[],
	policy: PricingPolicy,
): Promise<CartState> {
	let next: CartState = { ...cart, items: repricedItems };
	next = await refreshAppliedCoupons(ctx, next);
	next = await requoteShipping(ctx, next);
	return recalculate(next, policy);
}

export const checkoutRoutes = {
	"checkout/create-intent": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const input = (routeCtx.input ?? {}) as {
				customerEmail?: string;
				notes?: string;
			};

			const { sessionId } = resolveSessionId(routeCtx.request);
			const cart = await getCart(ctx, sessionId);
			if (!cart || cart.items.length === 0) {
				return new Response(JSON.stringify({ error: "Cart is empty" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			const client = await loadStripeClient(ctx);
			if (!client) {
				return new Response(
					JSON.stringify({ error: "Stripe not configured (settings:stripeSecretKey)" }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}

			const configuredProvider =
				(await ctx.kv.get<string>("settings:paymentProvider")) ?? DEFAULT_PAYMENT_PROVIDER_ID;
			const checkoutMode =
				(await ctx.kv.get<CheckoutMode>("settings:checkoutMode")) ?? DEFAULT_CHECKOUT_MODE;
			if (configuredProvider !== "stripe" && checkoutMode !== "embedded") {
				return new Response(
					JSON.stringify({
						error: `Embedded PaymentIntents are Stripe-only. Use /checkout/create-session for payment provider "${configuredProvider}", or set checkoutMode=embedded to keep Stripe Elements.`,
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}

			// Stamp any newly-provided email/notes onto the cart.
			const withContact: CartState = {
				...cart,
				...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
				...(input.notes ? { notes: input.notes } : {}),
			};

			// Server-side re-price + stock check.
			const { items, errors, stockEntries } = await repriceAndCheckStock(ctx, withContact);
			if (errors.length > 0) {
				return new Response(JSON.stringify({ error: "Cart validation failed", errors }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (!withContact.customerEmail || !withContact.customerEmail.includes("@")) {
				return new Response(JSON.stringify({ error: "customerEmail is required" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (!withContact.billingAddress || !withContact.shippingAddress) {
				return new Response(
					JSON.stringify({ error: "Billing and shipping addresses are required" }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}

			const policy = await readPricingPolicy(ctx);
			const recalculated = await finalizeCheckoutCart(ctx, withContact, items, policy);
			if (totalsChanged(withContact, recalculated)) {
				await save(ctx, recalculated);
				return new Response(
					JSON.stringify({
						error: "Cart totals changed — review and retry checkout",
						code: "cart_totals_changed",
						cart: recalculated,
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}
			if (recalculated.total.amount <= 0) {
				return new Response(JSON.stringify({ error: "Order total must be positive" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			await save(ctx, recalculated);

			const orderDraftId = randomId();

			// Stock soft-lock.
			if (stockEntries.length > 0) {
				await createLock(
					ctx,
					newLock(orderDraftId, sessionId, stockEntries, { ttlMs: LOCK_TTL_MS }),
				);
			}

			// Snapshot for webhook replay.
			await ctx.kv.set(`${DRAFT_PREFIX}${orderDraftId}`, {
				cart: recalculated,
				ttlMs: DRAFT_TTL_MS,
				createdAt: new Date().toISOString(),
			});

			// Vendor split (Connect). When enabled and cart has vendor items,
			// route the PI to the connected account with an application fee.
			// For v1.0 we only support single-vendor carts when Connect is on;
			// mixed platform+vendor or multi-vendor carts return 501 and the
			// merchant is directed to enable/disable Connect or split orders.
			let transferData: { destination: string; amount?: number } | undefined;
			let applicationFeeAmount: number | undefined;

			if (await connectEnabled(ctx)) {
				try {
					const plan = await computeSplit(ctx, recalculated);
					if (plan.mode === "single-vendor") {
						const g = plan.vendorGroups[0];
						if (!g) {
							return new Response(JSON.stringify({ error: "Split plan missing vendor group" }), {
								status: 500,
								headers: { "Content-Type": "application/json" },
							});
						}
						transferData = { destination: g.stripeAccountId };
						applicationFeeAmount = g.applicationFee.amount;
					} else if (plan.mode === "multi-vendor") {
						return new Response(
							JSON.stringify({
								error:
									"Multi-vendor checkouts are not supported in v1.0. Split the cart by vendor.",
								vendors: plan.vendorGroups.map((g) => g.vendorId),
							}),
							{ status: 501, headers: { "Content-Type": "application/json" } },
						);
					}
				} catch (err) {
					return new Response(
						JSON.stringify({
							error: err instanceof Error ? err.message : "Vendor split computation failed",
						}),
						{ status: 409, headers: { "Content-Type": "application/json" } },
					);
				}
			}

			const pi = await createPaymentIntent(
				ctx,
				{
					amount: recalculated.total.amount,
					currency: recalculated.currency.toLowerCase(),
					receiptEmail: recalculated.customerEmail,
					description: `Order draft ${orderDraftId}`,
					metadata: {
						orderDraftId,
						sessionId,
						siteUrl: ctx.site.url,
					},
					automaticPaymentMethods: { enabled: true },
					...(transferData ? { transferData } : {}),
					...(applicationFeeAmount !== undefined ? { applicationFeeAmount } : {}),
				},
				client,
				`pi:${orderDraftId}`,
			);

			// Return a raw Response to match the wire shape of every other
			// storefront route (cart/*, orders/*, etc.). Returning a plain
			// object would trigger emdash's default `apiSuccess(data)`
			// envelope, which wraps the payload as `{ data: { ... } }` —
			// CheckoutFormIsland expects the unwrapped object and reads
			// `body.clientSecret` directly. Without this the payment step
			// renders <Elements> with an undefined clientSecret and Stripe
			// fails to mount the PaymentElement, so step 2 looks empty.
			return new Response(
				JSON.stringify({
					clientSecret: pi.client_secret,
					paymentIntentId: pi.id,
					orderDraftId,
					total: recalculated.total,
					currency: recalculated.currency,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	},

	/**
	 * Hosted-checkout handoff — creates a Stripe Checkout Session and
	 * returns the URL the browser should redirect to.
	 *
	 *   POST /checkout/create-session
	 *   body: { notes? }      (email + full address collected by Stripe)
	 *
	 * Pre-conditions the storefront already satisfied before calling:
	 *   • Cart has at least one item.
	 *   • Cart has a `shippingAddress` — even a partial one is fine; we
	 *     only need country + postalCode to have picked a zone. Stripe
	 *     collects the full address on its page and the webhook merges
	 *     it back in via `session.shipping_details`.
	 *   • Cart has a `shippingMethod` (set via `cart/shipping-method`).
	 *     That single rate is passed to Stripe so the customer can't
	 *     downgrade to something we didn't price. Free-shipping carts
	 *     and digital-only carts skip this.
	 *
	 * Post-payment, Stripe fires both `checkout.session.completed` and
	 * `payment_intent.succeeded`. The session handler is authoritative
	 * for hosted-mode orders (it has the collected addresses); the PI
	 * handler short-circuits when it sees `metadata.checkoutMode ===
	 * "hosted"` on the PI, letting the session-level flow own order
	 * creation. See `routes/webhook.ts`.
	 *
	 * Hosted session creation goes through `resolveProvider()` so a
	 * registered non-Stripe adapter can own the redirect. Default
	 * `"stripe"` maps onto the same Checkout Session fields this route
	 * has always sent (shipping, tax, subscriptions, Connect).
	 */
	"checkout/create-session": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const input = (routeCtx.input ?? {}) as {
				notes?: string;
				customerEmail?: string;
			};

			const { sessionId } = resolveSessionId(routeCtx.request);
			const cart = await getCart(ctx, sessionId);
			if (!cart || cart.items.length === 0) {
				return new Response(JSON.stringify({ error: "Cart is empty" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			const provider = await resolveProvider(ctx.kv);
			const checkoutMode =
				(await ctx.kv.get<CheckoutMode>("settings:checkoutMode")) ?? DEFAULT_CHECKOUT_MODE;
			// For providers other than Stripe, "embedded" means on-page checkout
			// with that provider. (Stripe's on-page flow is Elements, through
			// checkout/create-intent; create-session stays hosted for Stripe.)
			const onPage = provider.id !== "stripe" && checkoutMode === "embedded";
			if (onPage && !providerCheckoutStyles(provider).includes("on_page")) {
				return new Response(
					JSON.stringify({
						error: `${provider.label} doesn't offer on-page checkout. Set the checkout flow to hosted in DashCommerce settings.`,
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}
			const creds = await loadPaymentProviderCredentials(ctx.kv, provider.id);
			if (!creds) {
				const message =
					provider.id === "stripe"
						? "Stripe not configured (settings:stripeSecretKey)"
						: `Payment provider "${provider.id}" is not configured`;
				return new Response(JSON.stringify({ error: message }), {
					status: 500,
					headers: { "Content-Type": "application/json" },
				});
			}
			const client = { secretKey: creds.secretKey };

			// Hosted mode needs a shippingMethod + at least a partial ship-to
			// address. `cart/shipping-methods` populates the method; the
			// storefront pre-checkout micro-form populates the address. A
			// cart with zero physical items (all isDigital) is allowed
			// without either — Stripe collects only billing in that case.
			const hasPhysical = cart.items.some((l) => !l.isDigital);
			if (hasPhysical) {
				if (!cart.shippingAddress?.country || !cart.shippingAddress?.postalCode) {
					return new Response(
						JSON.stringify({
							error: "Pick a ship-to country and postal code before paying.",
						}),
						{ status: 409, headers: { "Content-Type": "application/json" } },
					);
				}
				if (!cart.shippingMethod) {
					return new Response(JSON.stringify({ error: "Select a shipping method first." }), {
						status: 409,
						headers: { "Content-Type": "application/json" },
					});
				}
			}

			const withContact: CartState = {
				...cart,
				...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
				...(input.notes ? { notes: input.notes } : {}),
			};

			const { items, errors, stockEntries } = await repriceAndCheckStock(ctx, withContact);
			if (errors.length > 0) {
				return new Response(JSON.stringify({ error: "Cart validation failed", errors }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				});
			}

			const policy = await readPricingPolicy(ctx);
			const recalculated = await finalizeCheckoutCart(ctx, withContact, items, policy);
			if (totalsChanged(withContact, recalculated)) {
				await save(ctx, recalculated);
				return new Response(
					JSON.stringify({
						error: "Cart totals changed — review and retry checkout",
						code: "cart_totals_changed",
						cart: recalculated,
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}
			if (recalculated.total.amount <= 0) {
				return new Response(JSON.stringify({ error: "Order total must be positive" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (!provider.supportsCurrency(recalculated.currency)) {
				return new Response(
					JSON.stringify({
						error: `Currency "${recalculated.currency}" is not supported by payment provider "${provider.id}".`,
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			if (!provider.collectsCustomerDetails) {
				const missing = [
					...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recalculated.customerEmail ?? "") ? [] : ["email"]),
					...(recalculated.billingAddress || recalculated.shippingAddress ? [] : ["address"]),
				];
				if (missing.length > 0) {
					return new Response(
						JSON.stringify({
							error: `${provider.label} needs the customer's ${missing.join(" and ")} before payment. Send them with cart/contact.`,
							code: "customer_details_required",
							missing,
						}),
						{ status: 409, headers: { "Content-Type": "application/json" } },
					);
				}
			}
			await save(ctx, recalculated);

			const orderDraftId = randomId();

			if (stockEntries.length > 0) {
				await createLock(
					ctx,
					newLock(orderDraftId, sessionId, stockEntries, { ttlMs: LOCK_TTL_MS }),
				);
			}

			await ctx.kv.set(`${DRAFT_PREFIX}${orderDraftId}`, {
				cart: recalculated,
				ttlMs: DRAFT_TTL_MS,
				createdAt: new Date().toISOString(),
			});

			// Decide session mode. Stripe Checkout requires a session to
			// be entirely one-off (`payment`) or entirely recurring
			// (`subscription`) — a mixed cart needs the Invoice/Checkout
			// "add adjustable line items" feature which we don't ship in
			// v1.0. Gate mixed carts with a 409 and ask the customer to
			// split.
			const subscriptionLines = recalculated.items.filter((l) => !!l.subscriptionConfig);
			const oneTimeLines = recalculated.items.filter((l) => !l.subscriptionConfig);
			const isSubscriptionCart = subscriptionLines.length > 0 && oneTimeLines.length === 0;
			if (subscriptionLines.length > 0 && oneTimeLines.length > 0) {
				return new Response(
					JSON.stringify({
						error:
							"Subscription and one-time items can't be purchased together. Place them as separate orders.",
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}
			// Recurring vendor splits are not implemented for any provider:
			// Stripe's subscription path does not send transfer_data, and
			// Flutterwave's Payment Plans do not guarantee subaccount payouts on
			// renewal. Refuse rather than underpay the vendor.
			if (isSubscriptionCart && recalculated.items.some((item) => item.vendorId)) {
				return new Response(
					JSON.stringify({
						error:
							"Subscription carts with vendor-owned items are not supported yet. Split the subscription from the vendor items.",
						code: "subscription_vendor_items",
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}

			let transferDataPreview: { destination: string; amount?: number } | undefined;
			let applicationFeePreview: number | undefined;
			const hasVendorItems = recalculated.items.some((item) => item.vendorId);
			// Recurring vendor splits are not implemented for any provider:
			// Stripe's subscription path does not send transfer_data, and
			// Flutterwave's Payment Plans do not guarantee subaccount payouts on
			// renewal. Refuse rather than underpay the vendor.
			if (isSubscriptionCart && hasVendorItems) {
				return new Response(
					JSON.stringify({
						error:
							"Subscription carts with vendor-owned items are not supported yet. Split the subscription from the vendor items.",
						code: "subscription_vendor_items",
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}
			if (provider.id === "stripe" && (await connectEnabled(ctx))) {
				try {
					const plan = await computeSplit(ctx, recalculated);
					if (plan.mode === "single-vendor") {
						const g = plan.vendorGroups[0];
						if (g) {
							transferDataPreview = { destination: g.stripeAccountId };
							applicationFeePreview = g.applicationFee.amount;
						}
					}
				} catch {
					// Split errors are returned later on the Connect path; capability
					// check only needs to know whether Connect was requested.
				}
			}
			const unsupported = unsupportedHostedCheckoutFeatures(provider, {
				coupons: recalculated.discountTotal.amount > 0 && !isSubscriptionCart,
				connect: Boolean(transferDataPreview) || applicationFeePreview !== undefined,
				subscriptions: isSubscriptionCart,
				splits: provider.id !== "stripe" && hasVendorItems,
			});
			if (unsupported.length > 0) {
				return new Response(
					JSON.stringify({
						error: `Payment provider "${provider.id}" does not support: ${unsupported.join(", ")}. Remove those cart features or use a provider that declares them.`,
						unsupported,
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}

			// Non-Stripe split: core computes exact per-vendor minor amounts
			// from trusted cart prices and the vendor's payout account. The
			// provider only routes them.
			let allocations: PaymentProviderSplitAllocation[] | undefined;
			let platformRemainderMinor: number | undefined;
			if (provider.id !== "stripe" && hasVendorItems) {
				try {
					const plan = await computeProviderSplit(ctx, recalculated, provider.id);
					allocations = plan.allocations;
					platformRemainderMinor = plan.platformRemainderMinor;
				} catch (err) {
					return new Response(
						JSON.stringify({
							error: err instanceof Error ? err.message : "Vendor split computation failed",
						}),
						{ status: 409, headers: { "Content-Type": "application/json" } },
					);
				}
			}

			// Tax mode "stripe_tax" means defer tax calculation to Stripe.
			// Stripe Tax requires line items to declare tax_behavior so it
			// knows whether the price is pre- or post-tax. We default to
			// "exclusive" (add tax on top), which is the common online
			// store shape.
			const stripeTaxEnabled = policy.taxMode === "stripe_tax";

			// Build Checkout Session line items from the re-priced cart.
			// Product lines use unit prices (pre-discount). Shipping is passed
			// as `shipping_options`. Flat/table tax is appended as its own
			// line item (stripe_tax uses automatic_tax instead). Merchant
			// coupon discounts are applied via a one-time Stripe Coupon so
			// the hosted total matches cart.total.
			const lineItems: CheckoutLineItem[] = recalculated.items.map((line) => ({
				amount: line.unitPrice.amount,
				currency: line.unitPrice.currency.toLowerCase(),
				name: line.title,
				quantity: line.quantity,
				metadata: {
					productId: line.productId,
					...(line.variantId ? { variantId: line.variantId } : {}),
				},
				...(line.subscriptionConfig
					? {
							recurring: {
								interval: line.subscriptionConfig.interval,
								intervalCount: line.subscriptionConfig.intervalCount,
							},
						}
					: {}),
				...(stripeTaxEnabled ? { taxBehavior: "exclusive" as const } : {}),
			}));

			if (!stripeTaxEnabled && recalculated.taxTotal.amount > 0) {
				const taxLabel =
					recalculated.taxLines
						.map((l) => l.label)
						.filter(Boolean)
						.join(", ") || "Tax";
				lineItems.push({
					amount: recalculated.taxTotal.amount,
					currency: recalculated.currency.toLowerCase(),
					name: taxLabel,
					quantity: 1,
					metadata: { kind: "tax" },
				});
			}

			const shippingOptions: CheckoutShippingOption[] = recalculated.shippingMethod
				? [
						{
							displayName: recalculated.shippingMethod.label,
							amount: recalculated.shippingMethod.amount.amount,
							currency: recalculated.shippingMethod.amount.currency.toLowerCase(),
							metadata: { shippingMethodId: recalculated.shippingMethod.id },
						},
					]
				: [];

			// Use getPublicSiteUrl() to ensure we never use localhost or stale
			// database options (emdash:site_url) for Stripe redirect URLs.
			// Production deployments must set SITE_URL environment variable.
			const siteUrl = getPublicSiteUrl(ctx);

			// Pass `{CHECKOUT_SESSION_ID}` literally — Stripe substitutes
			// it server-side on redirect.
			const successUrl = `${siteUrl}/thank-you/${encodeURIComponent(orderDraftId)}?session_id={CHECKOUT_SESSION_ID}`;
			const cancelUrl = `${siteUrl}/checkout?canceled=1`;

			// Vendor split (Connect). Reuses the single-vendor path from
			// create-intent. Multi-vendor carts are rejected the same way.
			let transferData: { destination: string; amount?: number } | undefined;
			let applicationFeeAmount: number | undefined;
			if (provider.id === "stripe" && (await connectEnabled(ctx))) {
				try {
					const plan = await computeSplit(ctx, recalculated);
					if (plan.mode === "single-vendor") {
						const g = plan.vendorGroups[0];
						if (!g) {
							return new Response(JSON.stringify({ error: "Split plan missing vendor group" }), {
								status: 500,
								headers: { "Content-Type": "application/json" },
							});
						}
						transferData = { destination: g.stripeAccountId };
						applicationFeeAmount = g.applicationFee.amount;
					} else if (plan.mode === "multi-vendor") {
						return new Response(
							JSON.stringify({
								error:
									"Multi-vendor checkouts are not supported in v1.0. Split the cart by vendor.",
								vendors: plan.vendorGroups.map((g) => g.vendorId),
							}),
							{ status: 501, headers: { "Content-Type": "application/json" } },
						);
					}
				} catch (err) {
					return new Response(
						JSON.stringify({
							error: err instanceof Error ? err.message : "Vendor split failed",
						}),
						{ status: 409, headers: { "Content-Type": "application/json" } },
					);
				}
			}

			const metadata: Record<string, string> = {
				orderDraftId,
				sessionId,
				siteUrl: ctx.site.url,
				checkoutMode: "hosted",
				kind: isSubscriptionCart ? "subscription" : "payment",
			};

			// Subscriptions need a single trial window across the whole
			// cart (Checkout doesn't allow per-line trials for
			// price_data). We use the longest trial declared by any sub
			// item — most carts have one line anyway.
			const subscriptionTrialPeriodDays = isSubscriptionCart
				? subscriptionLines
						.map((l) => l.subscriptionConfig?.trialDays ?? 0)
						.reduce((max, v) => (v > max ? v : max), 0)
				: 0;

			// Rough product id hint so webhooks can correlate the
			// created Subscription row back to our content entry without
			// parsing line items. When multiple sub lines exist (not
			// common in v1 but possible), the first is stored; finer
			// mapping is still available via line_items expand.
			const subscriptionMetadata = isSubscriptionCart
				? {
						orderDraftId,
						sessionId,
						dashcommerceProductId: subscriptionLines[0]?.productId ?? "",
						...(subscriptionLines[0]?.variantId
							? { dashcommerceVariantId: subscriptionLines[0].variantId }
							: {}),
					}
				: undefined;

			let stripeDiscountCouponId: string | undefined;
			if (
				provider.id === "stripe" &&
				recalculated.discountTotal.amount > 0 &&
				!isSubscriptionCart
			) {
				const couponName = recalculated.coupons.map((c) => c.code).join("+") || "Cart discount";
				const stripeCoupon = await createOneTimeCoupon(
					ctx,
					{
						amountOff: recalculated.discountTotal.amount,
						currency: recalculated.currency,
						name: couponName,
					},
					client,
					`coupon:${orderDraftId}`,
				);
				stripeDiscountCouponId = stripeCoupon.id;
			}

			const initCheckout: InitCheckoutInput = {
				orderDraftId,
				amount: recalculated.total.amount,
				currency: recalculated.currency,
				customer: {
					email: recalculated.customerEmail ?? "",
				},
				lineItems: lineItems.map((li) => ({
					name: li.name,
					amount: li.amount,
					currency: li.currency,
					quantity: li.quantity,
					...(li.metadata ? { metadata: li.metadata } : {}),
					...(li.recurring ? { recurring: li.recurring } : {}),
					...(li.taxBehavior ? { taxBehavior: li.taxBehavior } : {}),
				})),
				successUrl,
				cancelUrl,
				mode: isSubscriptionCart ? "subscription" : "payment",
				billingAddressCollection: "auto",
				allowPromotionCodes: false,
				clientReferenceId: orderDraftId,
				metadata,
				...(allocations ? { allocations } : {}),
				...(platformRemainderMinor !== undefined ? { platformRemainderMinor } : {}),
				...(hasPhysical && recalculated.shippingAddress
					? {
							shippingAddressCollection: {
								allowedCountries: [recalculated.shippingAddress.country],
							},
						}
					: {}),
				...(shippingOptions.length > 0
					? {
							shippingOptions: shippingOptions.map((s) => ({
								id: s.metadata?.shippingMethodId,
								label: s.displayName,
								amount: s.amount,
								currency: s.currency,
								...(s.metadata ? { metadata: s.metadata } : {}),
							})),
						}
					: {}),
				...(stripeTaxEnabled ? { automaticTax: true } : {}),
				...(subscriptionMetadata ? { subscriptionMetadata } : {}),
				...(subscriptionTrialPeriodDays > 0 ? { subscriptionTrialPeriodDays } : {}),
				...(stripeDiscountCouponId ? { discounts: [{ coupon: stripeDiscountCouponId }] } : {}),
				...(!isSubscriptionCart
					? {
							paymentIntentMetadata: {
								orderDraftId,
								sessionId,
								checkoutMode: "hosted",
							},
							...(recalculated.customerEmail
								? { paymentIntentReceiptEmail: recalculated.customerEmail }
								: {}),
							...(transferData ? { transferData } : {}),
							...(applicationFeeAmount !== undefined ? { applicationFeeAmount } : {}),
						}
					: {}),
			};

			const checkoutResult = await provider.initCheckout(
				ctx,
				{ ...initCheckout, checkoutStyle: onPage ? "on_page" : "hosted" },
				creds,
			);
			const snapshot: CheckoutDraftSnapshot = {
				cart: recalculated,
				ttlMs: DRAFT_TTL_MS,
				createdAt: new Date().toISOString(),
				providerId: provider.id,
				checkoutReference: checkoutResult.checkoutReference,
				providerSplitRequested: Boolean(allocations?.length),
			};
			if (onPage) {
				if (checkoutResult.kind !== "on_page") {
					return new Response(
						JSON.stringify({ error: `${provider.label} did not return on-page checkout data` }),
						{ status: 502, headers: { "Content-Type": "application/json" } },
					);
				}
				await ctx.kv.set(draftKey(orderDraftId), snapshot);
				return new Response(
					JSON.stringify({
						kind: "on_page",
						providerId: provider.id,
						client: checkoutResult.client,
						returnUrl: `${siteUrl}/thank-you/${encodeURIComponent(orderDraftId)}`,
						sessionId: checkoutResult.checkoutReference,
						orderDraftId,
						total: recalculated.total,
						currency: recalculated.currency,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (checkoutResult.kind !== "redirect" || !checkoutResult.redirectUrl) {
				return new Response(
					JSON.stringify({
						error:
							provider.id === "stripe"
								? "Stripe did not return a hosted URL"
								: `Payment provider "${provider.id}" did not return a hosted URL`,
					}),
					{ status: 502, headers: { "Content-Type": "application/json" } },
				);
			}

			await ctx.kv.set(draftKey(orderDraftId), snapshot);

			return new Response(
				JSON.stringify({
					kind: "redirect",
					url: checkoutResult.redirectUrl,
					sessionId: checkoutResult.checkoutReference,
					orderDraftId,
					total: recalculated.total,
					currency: recalculated.currency,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	},

	/**
	 * Tells the storefront which checkout flow to render. Lets us keep
	 * all server-side logic out of Astro pages that don't have plugin
	 * context (static islands, etc.). Also saves storefronts from
	 * reading `settings:checkoutMode` directly.
	 */
	"checkout/mode": {
		public: true,
		handler: async (_routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (_routeCtx as unknown as PluginContext)) as PluginContext;
			const mode =
				(await ctx.kv.get<CheckoutMode>("settings:checkoutMode")) ?? DEFAULT_CHECKOUT_MODE;
			return new Response(JSON.stringify({ mode }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	},
};

export type CheckoutDraftSnapshot = {
	cart: CartState;
	ttlMs: number;
	createdAt: string;
	providerId?: string;
	checkoutReference?: string;
	providerSplitRequested?: boolean;
};

export function draftKey(orderDraftId: string): string {
	return `${DRAFT_PREFIX}${orderDraftId}`;
}

// re-exports so webhook route can reuse the helpers without reaching in
export { zero };

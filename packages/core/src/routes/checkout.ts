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
import { randomId } from "../util/ids";
import { recalculate, type PricingPolicy } from "../cart/calculate";
import { getCart, save } from "../cart/store";
import { createLock, newLock, sumActiveLocksForProduct } from "../cart/lock";
import { money, zero } from "../money";
import { resolvePrice } from "../products/pricing";
import { getVariant } from "../products/variants";
import { createPaymentIntent } from "../stripe/payment-intents";
import {
	createCheckoutSession,
	type CheckoutLineItem,
	type CheckoutShippingOption,
} from "../stripe/checkout-sessions";
import type { StripeClientOptions } from "../stripe/client";
import type { CartLineItem, CartState, StockLockEntry } from "../types";
import { normalizeProductFields } from "../products/normalize";
import { computeSplit, connectEnabled } from "../vendors/split";
import { resolveSessionId } from "./cart";
import { DEFAULT_CHECKOUT_MODE, type CheckoutMode } from "../settings/schema";

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

async function repriceAndCheckStock(
	ctx: PluginContext,
	cart: CartState,
): Promise<RepriceResult> {
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
		const fields = normalizeProductFields(
			record.data as Record<string, unknown>,
		);
		const variant = line.variantId ? await getVariant(ctx, line.variantId) : null;
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
			const recalculated = recalculate({ ...withContact, items }, policy);
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
							return new Response(
								JSON.stringify({ error: "Split plan missing vendor group" }),
								{ status: 500, headers: { "Content-Type": "application/json" } },
							);
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
							error:
								err instanceof Error ? err.message : "Vendor split computation failed",
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

			const client = await loadStripeClient(ctx);
			if (!client) {
				return new Response(
					JSON.stringify({ error: "Stripe not configured (settings:stripeSecretKey)" }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}

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
					return new Response(
						JSON.stringify({ error: "Select a shipping method first." }),
						{ status: 409, headers: { "Content-Type": "application/json" } },
					);
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
			const recalculated = recalculate({ ...withContact, items }, policy);
			if (recalculated.total.amount <= 0) {
				return new Response(JSON.stringify({ error: "Order total must be positive" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
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

			// Tax mode "stripe_tax" means defer tax calculation to Stripe.
			// Stripe Tax requires line items to declare tax_behavior so it
			// knows whether the price is pre- or post-tax. We default to
			// "exclusive" (add tax on top), which is the common online
			// store shape.
			const stripeTaxEnabled = policy.taxMode === "stripe_tax";

			// Build Checkout Session line items from the re-priced cart. We
			// deliberately do NOT push tax/discount/shipping as line items
			// here — taxes come from `automatic_tax` (when enabled), and
			// shipping is passed as `shipping_options`. Discounts that the
			// merchant's coupon engine already applied are baked into the
			// line `unit_amount` so the Stripe total matches `cart.total`
			// exactly.
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

			// Discount as a negative line item — Stripe rejects negative
			// `unit_amount` on Checkout, so we fold discounts into the
			// unit price above. If a merchant wants the discount broken
			// out visually on the Stripe page, they can use Stripe Coupons
			// (a Pass 2 item).

			const origin = new URL(routeCtx.request.url).origin;

			// Pass `{CHECKOUT_SESSION_ID}` literally — Stripe substitutes
			// it server-side on redirect.
			const successUrl = `${origin}/thank-you/${encodeURIComponent(orderDraftId)}?session_id={CHECKOUT_SESSION_ID}`;
			const cancelUrl = `${origin}/checkout?canceled=1`;

			// Vendor split (Connect). Reuses the single-vendor path from
			// create-intent. Multi-vendor carts are rejected the same way.
			let transferData: { destination: string; amount?: number } | undefined;
			let applicationFeeAmount: number | undefined;
			if (await connectEnabled(ctx)) {
				try {
					const plan = await computeSplit(ctx, recalculated);
					if (plan.mode === "single-vendor") {
						const g = plan.vendorGroups[0];
						if (!g) {
							return new Response(
								JSON.stringify({ error: "Split plan missing vendor group" }),
								{ status: 500, headers: { "Content-Type": "application/json" } },
							);
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

			const session = await createCheckoutSession(
				ctx,
				{
					mode: isSubscriptionCart ? "subscription" : "payment",
					successUrl,
					cancelUrl,
					lineItems,
					...(recalculated.customerEmail
						? { customerEmail: recalculated.customerEmail }
						: {}),
					...(hasPhysical && recalculated.shippingAddress
						? {
								shippingAddressCollection: {
									allowedCountries: [recalculated.shippingAddress.country],
								},
							}
						: {}),
					...(shippingOptions.length > 0 ? { shippingOptions } : {}),
					billingAddressCollection: "auto",
					allowPromotionCodes: false,
					clientReferenceId: orderDraftId,
					metadata,
					// Stripe Tax — the merchant toggled "stripe_tax" as the
					// cart's tax mode. Stripe Checkout then looks up the
					// buyer's jurisdiction from the billing/shipping address
					// and recomputes tax server-side on the hosted page.
					...(stripeTaxEnabled ? { automaticTax: true } : {}),
					...(subscriptionMetadata ? { subscriptionMetadata } : {}),
					...(subscriptionTrialPeriodDays > 0
						? { subscriptionTrialPeriodDays }
						: {}),
					// One-time-payment-only fields. `createCheckoutSession`
					// also gates these on `mode === "payment"`, but we
					// skip the whole block for subscription carts to keep
					// the intent obvious.
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
								...(transferData ? { paymentIntentTransferData: transferData } : {}),
								...(applicationFeeAmount !== undefined
									? { paymentIntentApplicationFeeAmount: applicationFeeAmount }
									: {}),
							}
						: {}),
				},
				client,
				`cs:${orderDraftId}`,
			);

			if (!session.url) {
				return new Response(
					JSON.stringify({ error: "Stripe did not return a hosted URL" }),
					{ status: 502, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(
				JSON.stringify({
					url: session.url,
					sessionId: session.id,
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
};

export function draftKey(orderDraftId: string): string {
	return `${DRAFT_PREFIX}${orderDraftId}`;
}

// re-exports so webhook route can reuse the helpers without reaching in
export { zero };

/**
 * Stripe webhook endpoint — public, signature-verified.
 *
 *   POST /checkout/webhook
 *
 * The body is read raw for HMAC verification, then parsed. We dispatch
 * on `event.type`:
 *
 *   payment_intent.succeeded  → createOrderFromPaymentIntent
 *   payment_intent.payment_failed / canceled → release stock lock
 *   charge.refunded           → recordRefundFromWebhook (idempotent dedup)
 *   refund.updated            → status update on refund row
 *   customer.subscription.*   → phase 7 (no-op here)
 *   invoice.*                 → phase 7 (no-op here)
 *
 * We always return 200 on duplicates (idempotency) and on handled events.
 * On signature failure we return 400. Any unhandled processing error
 * surfaces as 500 — Stripe will retry.
 */

import type { PluginContext, RouteContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import { isUniqueViolation } from "../util/storage";
import type { CartState, StripeEventRecord } from "../types";
import { deleteLock, getLock } from "../cart/lock";
import { clear as clearCart } from "../cart/store";
import {
	createOrderFromPaymentIntent,
	findOrderByPaymentIntent,
} from "../orders/create";
import { recordRefundFromWebhook } from "../orders/refund";
import { verifyStripeSignature } from "../stripe/webhook-verify";
import type { StripePaymentIntent } from "../stripe/payment-intents";
import { retrievePaymentIntent } from "../stripe/payment-intents";
import type {
	StripeCheckoutSession,
	StripeSessionAddress,
} from "../stripe/checkout-sessions";
import type { StripeClientOptions } from "../stripe/client";
import type { StripeRefund } from "../stripe/refunds";
import type { StripeAccount, StripePayout } from "../stripe/connect";
import type { StripeInvoice, StripeSubscription } from "../stripe/subscriptions";
import type { Address, CountryCode, Customer } from "../types";
import {
	findVendorByStripeAccountId,
	upsertVendorFromStripeAccount,
} from "../vendors/onboarding";
import { recordPayoutFromStripe } from "../vendors/payouts";
import {
	subsStore,
	upsertFromStripe,
	upsertInvoiceFromStripe,
	findSubscription,
} from "../subscriptions/create";
import { handleInvoicePaymentFailed } from "../subscriptions/dunning";
import {
	sendSubscriptionRenewed,
	sendVendorActivated,
	sendVendorPayout,
} from "../emails";
import { draftKey, type CheckoutDraftSnapshot } from "./checkout";

type StripeEventsStore = StorageCollection<StripeEventRecord>;
function stripeEventsStore(ctx: PluginContext): StripeEventsStore {
	return (ctx.storage as unknown as { stripe_events: StripeEventsStore })
		.stripe_events;
}

/**
 * Insert an event-dedup row. Returns `true` if this is a fresh event
 * and the caller should proceed with processing; `false` if a previous
 * delivery already wrote the row (webhook retry — skip).
 *
 * We record the row BEFORE handler side effects to close the window
 * between delivery and side-effect commit. If handler work fails after
 * the record is written, Stripe's retry will see the dedup hit and
 * skip — operator intervention is required. That's the right
 * trade-off: a duplicate dunning email or duplicate stock decrement is
 * worse than a rare dropped event that the merchant can replay
 * manually from the Stripe dashboard.
 */
async function recordStripeEvent(
	ctx: PluginContext,
	stripeEventId: string,
	type: string,
): Promise<boolean> {
	try {
		const id = randomId();
		await stripeEventsStore(ctx).put(id, {
			id,
			stripeEventId,
			type,
			createdAt: new Date().toISOString(),
		});
		return true;
	} catch (err) {
		if (isUniqueViolation(err)) {
			ctx.log.info("Stripe webhook deduped", { stripeEventId, type });
			return false;
		}
		throw err;
	}
}

async function handlePaymentIntentSucceeded(
	ctx: PluginContext,
	pi: StripePaymentIntent,
): Promise<Response> {
	const orderDraftId = pi.metadata?.orderDraftId;
	if (!orderDraftId) {
		ctx.log.warn("payment_intent.succeeded missing orderDraftId in metadata", { piId: pi.id });
		return new Response(JSON.stringify({ received: true, skipped: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Hosted-checkout PIs are owned by `checkout.session.completed` —
	// that handler has `session.customer_details` + `shipping_details`
	// which we NEED to populate the order. If this event wins the race
	// we'd throw on the missing-address check. Short-circuit and let
	// session.completed be authoritative. If session.completed already
	// ran, it created the order — the next check catches that too.
	if (pi.metadata?.checkoutMode === "hosted") {
		const existing = await findOrderByPaymentIntent(ctx, pi.id);
		if (existing) {
			return new Response(JSON.stringify({ received: true, duplicate: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(
			JSON.stringify({ received: true, deferredToSessionCompleted: true }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	// Idempotent: return on duplicate
	const existing = await findOrderByPaymentIntent(ctx, pi.id);
	if (existing) {
		return new Response(JSON.stringify({ received: true, duplicate: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	const snapshot = await ctx.kv.get<CheckoutDraftSnapshot>(draftKey(orderDraftId));
	if (!snapshot) {
		ctx.log.error("No cart snapshot for orderDraftId", { orderDraftId, piId: pi.id });
		return new Response(JSON.stringify({ error: "Missing draft snapshot" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}

	const cart: CartState = snapshot.cart;
	const { order, duplicate } = await createOrderFromPaymentIntent(ctx, {
		paymentIntent: pi,
		cartSnapshot: cart,
		orderDraftId,
	});

	if (!duplicate) {
		await ctx.kv.delete(draftKey(orderDraftId));
		// Cart is fulfilled — wipe it so the buyer's next page load
		// gets a fresh empty cart keyed by the same session cookie.
		// Safe under webhook retries because the `duplicate` short-circuit
		// above guards against re-entry on the same PI.
		try {
			await clearCart(ctx, cart.sessionId);
		} catch (err) {
			ctx.log.warn("Failed to clear cart after order", {
				sessionId: cart.sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return new Response(
		JSON.stringify({ received: true, orderId: order.id, orderNumber: order.orderNumber }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * Split a Stripe "name" string into first/last. Stripe sends a single
 * combined `name` field on customer_details / shipping_details; our
 * Address type wants them separately. We take everything before the
 * first space as first name, rest as last — good enough for order
 * fulfillment. Operators can edit on the order page.
 */
function splitName(name: string | undefined): { firstName: string; lastName: string } {
	const s = (name ?? "").trim();
	if (!s) return { firstName: "", lastName: "" };
	const idx = s.indexOf(" ");
	if (idx === -1) return { firstName: s, lastName: "" };
	return { firstName: s.slice(0, idx), lastName: s.slice(idx + 1).trim() };
}

function addressFromSession(
	name: string | undefined,
	addr: StripeSessionAddress | undefined,
	phone?: string,
): Address | null {
	if (!addr || !addr.country) return null;
	const { firstName, lastName } = splitName(name);
	return {
		firstName,
		lastName,
		line1: addr.line1 ?? "",
		...(addr.line2 ? { line2: addr.line2 } : {}),
		city: addr.city ?? "",
		region: addr.state ?? "",
		postalCode: addr.postal_code ?? "",
		country: addr.country.toUpperCase() as CountryCode,
		...(phone ? { phone } : {}),
	};
}

async function loadStripeClient(ctx: PluginContext): Promise<StripeClientOptions | null> {
	const secret = await ctx.kv.get<string>("settings:stripeSecretKey");
	if (!secret) return null;
	return { secretKey: secret };
}

type CustomersStore = StorageCollection<Customer>;
function customersStore(ctx: PluginContext): CustomersStore {
	return (ctx.storage as unknown as { customers: CustomersStore }).customers;
}

/**
 * Find-or-create a customer row keyed on email, and stamp the Stripe
 * customer id onto it. Called from the subscription-mode branch of
 * `checkout.session.completed` so the later `customer.subscription.*`
 * webhooks can resolve the customer via `stripeCustomerId` lookup (see
 * `subscriptions/create.ts#resolveCustomerId`).
 *
 * Does NOT increment order counters or spend totals — those belong to
 * the order path.
 */
async function linkStripeCustomer(
	ctx: PluginContext,
	email: string,
	stripeCustomerId: string,
): Promise<Customer> {
	const existingResult = await customersStore(ctx).query({
		where: { email },
		limit: 1,
	});
	const existingRow = existingResult.items[0];
	const now = new Date().toISOString();

	if (existingRow) {
		const prev = { ...(existingRow.data as Customer), id: existingRow.id };
		if (prev.stripeCustomerId === stripeCustomerId) return prev;
		const updated: Customer = {
			...prev,
			stripeCustomerId: prev.stripeCustomerId ?? stripeCustomerId,
			updatedAt: now,
		};
		await customersStore(ctx).put(updated.id, updated);
		return updated;
	}

	const fresh: Customer = {
		id: randomId(),
		email,
		stripeCustomerId,
		ordersCount: 0,
		totalSpent: {},
		acceptsMarketing: false,
		createdAt: now,
		updatedAt: now,
	};
	await customersStore(ctx).put(fresh.id, fresh);
	return fresh;
}

/**
 * `checkout.session.completed` — authoritative for hosted-mode orders.
 *
 * Merges the address Stripe collected onto our cart snapshot, then
 * drives the same `createOrderFromPaymentIntent` path used by the
 * embedded flow. The PI itself is fetched via the API (the event only
 * carries the id).
 *
 * Subscription-mode sessions are ignored here for Pass 1 — subscription
 * creation flows through `customer.subscription.*` events handled
 * elsewhere. When Pass 2 wires subscription line_items we revisit.
 */
async function handleCheckoutSessionCompleted(
	ctx: PluginContext,
	session: StripeCheckoutSession,
): Promise<Response> {
	const orderDraftId = session.metadata?.orderDraftId;
	if (!orderDraftId) {
		ctx.log.warn("checkout.session.completed missing orderDraftId in metadata", {
			sessionId: session.id,
		});
		return new Response(JSON.stringify({ received: true, skipped: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Subscription mode: Stripe creates the Subscription object itself
	// and will fire `customer.subscription.created` immediately after.
	// We don't create an order here (subscriptions are tracked
	// separately), but we do:
	//   - Link the Stripe Customer id to the local customer row so the
	//     sub-created webhook can find the customer (it queries by
	//     stripeCustomerId).
	//   - Clean up the checkout draft + any stock lock.
	if (session.mode === "subscription") {
		const email = session.customer_details?.email;
		const stripeCustomerId = session.customer;
		if (email && stripeCustomerId) {
			try {
				await linkStripeCustomer(ctx, email, stripeCustomerId);
			} catch (err) {
				ctx.log.warn("Failed to link Stripe customer id on subscription session", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		// Load the draft (if still present) so we can clear the buyer's
		// cart. Under retries the draft may be gone — that's fine, the
		// cart was already wiped on the first delivery.
		const draft = await ctx.kv.get<CheckoutDraftSnapshot>(draftKey(orderDraftId));
		await ctx.kv.delete(draftKey(orderDraftId));
		const lock = await getLock(ctx, orderDraftId);
		if (lock) await deleteLock(ctx, orderDraftId);
		if (draft) {
			try {
				await clearCart(ctx, draft.cart.sessionId);
			} catch (err) {
				ctx.log.warn("Failed to clear cart after subscription checkout", {
					sessionId: draft.cart.sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return new Response(
			JSON.stringify({
				received: true,
				kind: "subscription",
				sessionId: session.id,
				stripeSubscriptionId: session.subscription,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	if (session.mode !== "payment") {
		return new Response(
			JSON.stringify({ received: true, skipped: true, reason: `mode=${session.mode}` }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	if (!session.payment_intent) {
		ctx.log.warn("checkout.session.completed has no payment_intent", {
			sessionId: session.id,
		});
		return new Response(JSON.stringify({ received: true, skipped: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Idempotent on PI (same guard as payment_intent.succeeded).
	const existing = await findOrderByPaymentIntent(ctx, session.payment_intent);
	if (existing) {
		return new Response(JSON.stringify({ received: true, duplicate: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	const snapshot = await ctx.kv.get<CheckoutDraftSnapshot>(draftKey(orderDraftId));
	if (!snapshot) {
		ctx.log.error("No cart snapshot for checkout.session.completed", {
			orderDraftId,
			sessionId: session.id,
		});
		return new Response(JSON.stringify({ error: "Missing draft snapshot" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Merge session-collected contact into the cart snapshot. Stripe is
	// canonical here — a customer who typed a different email/address
	// on Stripe's page overrides the partial we captured pre-redirect.
	const shippingAddr = addressFromSession(
		session.shipping_details?.name ?? session.customer_details?.name,
		session.shipping_details?.address ?? session.customer_details?.address,
		session.shipping_details?.phone ?? session.customer_details?.phone,
	);
	const billingAddr = addressFromSession(
		session.customer_details?.name,
		session.customer_details?.address,
		session.customer_details?.phone,
	);

	const cart: CartState = {
		...snapshot.cart,
		...(session.customer_details?.email
			? { customerEmail: session.customer_details.email }
			: {}),
		...(shippingAddr ? { shippingAddress: shippingAddr } : {}),
		...(billingAddr
			? { billingAddress: billingAddr }
			: shippingAddr
				? { billingAddress: shippingAddr }
				: {}),
	};

	if (!cart.billingAddress || !cart.shippingAddress) {
		// Digital-only carts legitimately have no shipping address;
		// fall back to the billing address for the shipping slot so the
		// downstream order-creation precondition holds.
		if (cart.billingAddress && !cart.shippingAddress) {
			cart.shippingAddress = cart.billingAddress;
		} else if (cart.shippingAddress && !cart.billingAddress) {
			cart.billingAddress = cart.shippingAddress;
		} else {
			ctx.log.error("Stripe session completed without any usable address", {
				sessionId: session.id,
				orderDraftId,
			});
			return new Response(
				JSON.stringify({ error: "Session missing address" }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		}
	}

	// Retrieve the full PI so `createOrderFromPaymentIntent` has the
	// fields it reads (amount_received, latest_charge, status, etc.).
	const client = await loadStripeClient(ctx);
	if (!client) {
		return new Response(
			JSON.stringify({ error: "Stripe not configured" }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
	const pi = await retrievePaymentIntent(ctx, session.payment_intent, client);

	const { order, duplicate } = await createOrderFromPaymentIntent(ctx, {
		paymentIntent: pi,
		cartSnapshot: cart,
		orderDraftId,
	});

	if (!duplicate) {
		await ctx.kv.delete(draftKey(orderDraftId));
		try {
			await clearCart(ctx, cart.sessionId);
		} catch (err) {
			ctx.log.warn("Failed to clear cart after hosted checkout", {
				sessionId: cart.sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return new Response(
		JSON.stringify({
			received: true,
			orderId: order.id,
			orderNumber: order.orderNumber,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/** `checkout.session.async_payment_failed` / `checkout.session.expired` */
async function handleCheckoutSessionTerminated(
	ctx: PluginContext,
	session: StripeCheckoutSession,
): Promise<Response> {
	const orderDraftId = session.metadata?.orderDraftId;
	if (orderDraftId) {
		const lock = await getLock(ctx, orderDraftId);
		if (lock) await deleteLock(ctx, orderDraftId);
	}
	return new Response(JSON.stringify({ received: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

async function handlePaymentIntentFailure(
	ctx: PluginContext,
	pi: StripePaymentIntent,
): Promise<Response> {
	const orderDraftId = pi.metadata?.orderDraftId;
	if (orderDraftId) {
		const lock = await getLock(ctx, orderDraftId);
		if (lock) await deleteLock(ctx, orderDraftId);
	}
	return new Response(JSON.stringify({ received: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

interface StripeCharge {
	id: string;
	payment_intent?: string;
	refunds?: { data: StripeRefund[] };
}

async function handleChargeRefunded(
	ctx: PluginContext,
	charge: StripeCharge,
): Promise<Response> {
	if (!charge.payment_intent) {
		return new Response(JSON.stringify({ received: true, skipped: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}
	const order = await findOrderByPaymentIntent(ctx, charge.payment_intent);
	if (!order) {
		ctx.log.warn("charge.refunded for unknown order", {
			chargeId: charge.id,
			piId: charge.payment_intent,
		});
		return new Response(JSON.stringify({ received: true, orphan: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}
	const refunds = charge.refunds?.data ?? [];
	for (const r of refunds) {
		await recordRefundFromWebhook(ctx, order, r);
	}
	return new Response(JSON.stringify({ received: true, refundsProcessed: refunds.length }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

async function readRawBody(req: Request): Promise<string> {
	return req.text();
}

export const webhookRoutes = {
	"checkout/webhook": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const req = routeCtx.request;
			const sigHeader = req.headers.get("stripe-signature");
			if (!sigHeader) {
				return new Response(JSON.stringify({ error: "Missing Stripe-Signature" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			const secret = await ctx.kv.get<string>("settings:stripeWebhookSecret");
			if (!secret) {
				return new Response(JSON.stringify({ error: "Webhook secret not configured" }), {
					status: 500,
					headers: { "Content-Type": "application/json" },
				});
			}

			const payload = await readRawBody(req);
			const verified = await verifyStripeSignature({
				payload,
				signatureHeader: sigHeader,
				secret,
			});
			if (!verified.ok) {
				ctx.log.warn("Stripe webhook signature invalid", { reason: verified.reason });
				return new Response(
					JSON.stringify({ error: `Invalid signature: ${verified.reason}` }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}

			let event: {
				id: string;
				type: string;
				data: { object: unknown };
			};
			try {
				event = JSON.parse(payload);
			} catch {
				return new Response(JSON.stringify({ error: "Invalid JSON" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Event-id-level idempotency: duplicate deliveries short-circuit
			// before any handler runs. Downstream resource-level dedup
			// (stripePaymentIntentId, stripeRefundId, …) still protects
			// against out-of-order deliveries for different events against
			// the same resource.
			if (event.id) {
				const fresh = await recordStripeEvent(ctx, event.id, event.type);
				if (!fresh) {
					return new Response(
						JSON.stringify({ received: true, duplicate: true }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
			}

			try {
				switch (event.type) {
					case "payment_intent.succeeded":
						return await handlePaymentIntentSucceeded(
							ctx,
							event.data.object as StripePaymentIntent,
						);
					case "payment_intent.payment_failed":
					case "payment_intent.canceled":
						return await handlePaymentIntentFailure(
							ctx,
							event.data.object as StripePaymentIntent,
						);
					case "checkout.session.completed":
						return await handleCheckoutSessionCompleted(
							ctx,
							event.data.object as StripeCheckoutSession,
						);
					case "checkout.session.async_payment_failed":
					case "checkout.session.expired":
						return await handleCheckoutSessionTerminated(
							ctx,
							event.data.object as StripeCheckoutSession,
						);
					case "charge.refunded":
						return await handleChargeRefunded(
							ctx,
							event.data.object as StripeCharge,
						);
					case "customer.subscription.created":
					case "customer.subscription.updated":
					case "customer.subscription.resumed":
					case "customer.subscription.paused":
						await upsertFromStripe(
							ctx,
							event.data.object as StripeSubscription,
						);
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					case "customer.subscription.deleted": {
						const sub = event.data.object as StripeSubscription;
						const local = await findSubscription(ctx, sub.id);
						if (local) {
							await subsStore(ctx).put(local.id, {
								...local,
								status: "canceled",
								canceledAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
							});
						}
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					case "invoice.payment_succeeded":
					case "invoice.paid": {
						const stripeInvoice = event.data.object as StripeInvoice;
						const invoiceRecord = await upsertInvoiceFromStripe(
							ctx,
							stripeInvoice,
						);
						// Renewal email on cycle invoices only. The initial
						// period is covered by the order receipt issued at
						// checkout, so we skip `subscription_create` /
						// `subscription` to avoid a duplicate on the very
						// first paid period.
						if (
							invoiceRecord &&
							stripeInvoice.billing_reason === "subscription_cycle"
						) {
							await sendSubscriptionRenewedEmail(ctx, invoiceRecord);
						}
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					case "invoice.payment_failed":
						await handleInvoicePaymentFailed(
							ctx,
							event.data.object as StripeInvoice,
						);
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					case "account.updated": {
						const account = event.data.object as StripeAccount;
						const previous =
							await findVendorByStripeAccountId(ctx, account.id);
						const wasActive =
							previous?.onboardingStatus === "active" &&
							previous.chargesEnabled === true;
						const vendor = await upsertVendorFromStripeAccount(
							ctx,
							account,
						);
						// Activation edge: chargesEnabled flipped false→true.
						// Email is idempotent via a KV marker inside the send
						// helper, so even webhook retries won't dupe.
						if (vendor && !wasActive && vendor.chargesEnabled) {
							await sendVendorActivated(
								ctx,
								vendor,
								ctx.url("/vendor/dashboard"),
							);
						}
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					case "payout.paid":
					case "payout.failed":
					case "payout.canceled":
					case "payout.updated": {
						const payout = event.data.object as StripePayout;
						const acctRaw = (event as unknown as { account?: string }).account;
						if (!acctRaw) {
							ctx.log.warn("payout.* missing event.account field", {
								payoutId: payout.id,
							});
							return new Response(JSON.stringify({ received: true, skipped: true }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							});
						}
						const payoutRecord = await recordPayoutFromStripe(
							ctx,
							acctRaw,
							payout,
						);
						if (payoutRecord && event.type === "payout.paid") {
							const vendor = await findVendorByStripeAccountId(
								ctx,
								acctRaw,
							);
							if (vendor) {
								await sendVendorPayout(
									ctx,
									vendor,
									payoutRecord,
									ctx.url("/vendor/dashboard"),
								);
							}
						}
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					default:
						return new Response(
							JSON.stringify({ received: true, type: event.type, skipped: true }),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
				}
			} catch (err) {
				ctx.log.error("Stripe webhook handler error", {
					type: event.type,
					error: err instanceof Error ? err.message : String(err),
				});
				return new Response(
					JSON.stringify({
						error: err instanceof Error ? err.message : "Webhook handler failed",
					}),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
		},
	},
};

/**
 * Load the matching subscription + customer for a `SubscriptionInvoice`
 * and dispatch the renewal email. Quiet-fails when either record is
 * missing — the invoice is already persisted and Stripe has been 200'd,
 * so a send miss is recoverable.
 */
async function sendSubscriptionRenewedEmail(
	ctx: PluginContext,
	invoice: import("../types").SubscriptionInvoice,
): Promise<void> {
	try {
		const sub = await subsStore(ctx).get(invoice.subscriptionId);
		if (!sub) return;
		const customerRow = await (
			ctx.storage as unknown as {
				customers: { get(id: string): Promise<Customer | null> };
			}
		).customers.get((sub as import("../types").Subscription).customerId);
		if (!customerRow?.email) return;
		await sendSubscriptionRenewed(ctx, {
			customer: { ...customerRow, id: customerRow.id },
			subscription: sub as import("../types").Subscription,
			invoice,
			siteName: ctx.site.name,
			portalUrl: ctx.url("/account"),
		});
	} catch (err) {
		ctx.log.warn("subscription-renewed email skipped", {
			invoiceId: invoice.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

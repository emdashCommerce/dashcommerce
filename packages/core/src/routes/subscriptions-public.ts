/**
 * Public subscription self-service routes, auth'd via signed tokens.
 *
 *   GET  /subscriptions/state?token=…       → current state (no Stripe round-trip)
 *   POST /subscriptions/cancel              body: { token, mode: "immediate" | "at_period_end" }
 *   POST /subscriptions/pause               body: { token, resumesAt?: number — unix seconds }
 *   POST /subscriptions/resume              body: { token }
 *   POST /subscriptions/portal              body: { token, returnUrl? } → Stripe Billing Portal URL
 *
 * Routes use static paths + query/body params because emdash's plugin
 * route registry does exact-string matching (no `:param` support).
 *
 * The token carries the subscription id + expiry + HMAC. Every lifecycle
 * call forwards to Stripe; the `customer.subscription.updated` webhook
 * mirrors the change back into our storage. We do NOT mutate our local
 * row directly to keep Stripe authoritative.
 *
 * The portal action hands out a Stripe-hosted Billing Portal URL so
 * customers can update cards, download invoices, and manage billing
 * without us rebuilding that UI. The token verifies subscription
 * ownership; the portal session is then pinned to the subscription's
 * Stripe customer id.
 */

import type { PluginContext, RouteContext } from "emdash";
import type { StripeClientOptions } from "../stripe/client";
import { createBillingPortalSession } from "../stripe/checkout-sessions";
import { findSubscription } from "../subscriptions/create";
import { cancel, pause, resume } from "../subscriptions/lifecycle";
import { verifyToken } from "../subscriptions/tokens";
import type { Customer, Subscription } from "../types";

async function loadStripeClient(ctx: PluginContext): Promise<StripeClientOptions | null> {
	const secret = await ctx.kv.get<string>("settings:stripeSecretKey");
	if (!secret) return null;
	return { secretKey: secret };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Read the token from `?token=…` (GET) or the JSON body (POST). Older
 * client callers may still send tokens via path segments; we fall back
 * to the last non-action segment for backwards-compat even though the
 * new route names are static.
 */
function extractToken(
	req: Request,
	input: { token?: string } | undefined,
): string | null {
	if (input?.token) return input.token;
	const url = new URL(req.url);
	const qs = url.searchParams.get("token");
	if (qs) return qs;
	return null;
}

async function loadAuthorisedSub(
	ctx: PluginContext,
	token: string | null,
): Promise<
	| { ok: true; subscription: Subscription }
	| { ok: false; response: Response }
> {
	if (!token) {
		return { ok: false, response: jsonResponse({ error: "Missing token" }, 400) };
	}
	const verified = await verifyToken(ctx, token);
	if (!verified.ok || !verified.subscriptionId) {
		return {
			ok: false,
			response: jsonResponse({ error: `Invalid token: ${verified.reason}` }, 401),
		};
	}
	const sub = await findSubscription(ctx, verified.subscriptionId);
	if (!sub) {
		return { ok: false, response: jsonResponse({ error: "Subscription not found" }, 404) };
	}
	return { ok: true, subscription: sub };
}

async function handleState(
	routeCtx: RouteContext,
	_ctx?: PluginContext,
): Promise<Response> {
	const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
	const token = extractToken(routeCtx.request, routeCtx.input as { token?: string });
	const loaded = await loadAuthorisedSub(ctx, token);
	if (!loaded.ok) return loaded.response;
	return jsonResponse({ subscription: loaded.subscription });
}

async function handleCancel(
	routeCtx: RouteContext,
	_ctx?: PluginContext,
): Promise<Response> {
	const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
	const input = (routeCtx.input ?? {}) as {
		token?: string;
		mode?: "immediate" | "at_period_end";
	};
	const loaded = await loadAuthorisedSub(ctx, extractToken(routeCtx.request, input));
	if (!loaded.ok) return loaded.response;

	const client = await loadStripeClient(ctx);
	if (!client) return jsonResponse({ error: "Stripe not configured" }, 500);

	try {
		const updated = await cancel(ctx, {
			subscriptionId: loaded.subscription.id,
			mode: input.mode ?? "at_period_end",
			client,
		});
		return jsonResponse({ stripeStatus: updated.status, stripeSubscriptionId: updated.id });
	} catch (err) {
		ctx.log.error("Subscription cancel failed", {
			subscriptionId: loaded.subscription.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return jsonResponse(
			{ error: err instanceof Error ? err.message : "Subscription update failed" },
			500,
		);
	}
}

async function handlePause(
	routeCtx: RouteContext,
	_ctx?: PluginContext,
): Promise<Response> {
	const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
	const input = (routeCtx.input ?? {}) as {
		token?: string;
		resumesAt?: number;
	};
	const loaded = await loadAuthorisedSub(ctx, extractToken(routeCtx.request, input));
	if (!loaded.ok) return loaded.response;

	const client = await loadStripeClient(ctx);
	if (!client) return jsonResponse({ error: "Stripe not configured" }, 500);

	try {
		const updated = await pause(ctx, {
			subscriptionId: loaded.subscription.id,
			...(input.resumesAt !== undefined ? { resumesAt: input.resumesAt } : {}),
			client,
		});
		return jsonResponse({ stripeStatus: updated.status, stripeSubscriptionId: updated.id });
	} catch (err) {
		ctx.log.error("Subscription pause failed", {
			subscriptionId: loaded.subscription.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return jsonResponse(
			{ error: err instanceof Error ? err.message : "Subscription update failed" },
			500,
		);
	}
}

async function handleResume(
	routeCtx: RouteContext,
	_ctx?: PluginContext,
): Promise<Response> {
	const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
	const input = (routeCtx.input ?? {}) as { token?: string };
	const loaded = await loadAuthorisedSub(ctx, extractToken(routeCtx.request, input));
	if (!loaded.ok) return loaded.response;

	const client = await loadStripeClient(ctx);
	if (!client) return jsonResponse({ error: "Stripe not configured" }, 500);

	try {
		const updated = await resume(ctx, {
			subscriptionId: loaded.subscription.id,
			client,
		});
		return jsonResponse({ stripeStatus: updated.status, stripeSubscriptionId: updated.id });
	} catch (err) {
		ctx.log.error("Subscription resume failed", {
			subscriptionId: loaded.subscription.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return jsonResponse(
			{ error: err instanceof Error ? err.message : "Subscription update failed" },
			500,
		);
	}
}

/**
 * Hand out a Stripe-hosted Billing Portal URL. Requires the
 * subscription to have been created by a real Stripe customer (i.e.
 * the sub-created webhook found an existing customer row for the
 * shopper's email — see `handleCheckoutSessionCompleted` which
 * stamps `stripeCustomerId` onto the customer via `linkStripeCustomer`).
 *
 * The portal URL is short-lived (~5 min). We build a fresh one per
 * request rather than caching, so a leaked URL can't be replayed.
 */
async function handlePortal(
	routeCtx: RouteContext,
	_ctx?: PluginContext,
): Promise<Response> {
	const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
	const input = (routeCtx.input ?? {}) as { token?: string; returnUrl?: string };
	const loaded = await loadAuthorisedSub(ctx, extractToken(routeCtx.request, input));
	if (!loaded.ok) return loaded.response;

	// Portal requires a Stripe customer id. Resolve via the local
	// customer row the subscription is linked to.
	const customerId = loaded.subscription.customerId;
	if (!customerId) {
		return jsonResponse(
			{ error: "Subscription has no linked customer — cannot open portal" },
			409,
		);
	}
	const row = await (
		ctx.storage as unknown as {
			customers: { get(id: string): Promise<unknown> };
		}
	).customers.get(customerId);
	const customer = row
		? ({ ...(row as object), id: customerId } as unknown as Customer)
		: null;
	if (!customer?.stripeCustomerId) {
		return jsonResponse(
			{
				error:
					"No Stripe customer on file for this subscription. This usually means the subscription was created before the portal feature was enabled.",
			},
			409,
		);
	}

	const client = await loadStripeClient(ctx);
	if (!client) return jsonResponse({ error: "Stripe not configured" }, 500);

	const origin = new URL(routeCtx.request.url).origin;
	const returnUrl = input.returnUrl ?? `${origin}/account`;

	try {
		const portal = await createBillingPortalSession(
			ctx,
			{ customer: customer.stripeCustomerId, returnUrl },
			client,
			`bp:${loaded.subscription.id}:${Date.now()}`,
		);
		return jsonResponse({ url: portal.url });
	} catch (err) {
		ctx.log.error("Billing portal session create failed", {
			subscriptionId: loaded.subscription.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return jsonResponse(
			{ error: err instanceof Error ? err.message : "Portal session failed" },
			500,
		);
	}
}

export const subscriptionsPublicRoutes = {
	"subscriptions/state": { public: true, handler: handleState },
	"subscriptions/cancel": { public: true, handler: handleCancel },
	"subscriptions/pause": { public: true, handler: handlePause },
	"subscriptions/resume": { public: true, handler: handleResume },
	"subscriptions/portal": { public: true, handler: handlePortal },
};

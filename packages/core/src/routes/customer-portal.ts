/**
 * Customer self-service — "email me a billing portal link".
 *
 *   POST /customer/portal-link
 *     body: { email: string; returnUrl?: string }
 *     → { sent: true }
 *
 * DashCommerce uses email-gated accounts, so we don't expose a "is this
 * email known?" endpoint. This route always responds 200 `{sent: true}`
 * regardless of whether the email resolves to a customer row — the
 * message the caller sees is "check your inbox; if we have a Stripe
 * customer on file we'll email you a portal link". That prevents using
 * the endpoint as a customer-enumeration oracle.
 *
 * When a customer matches and has a `stripeCustomerId` (set by the
 * `checkout.session.completed` / `payment_intent.succeeded` webhook
 * handlers), we create a fresh Stripe Billing Portal session and email
 * the URL. Portal URLs are single-use and short-lived on Stripe's side,
 * so mailing them directly is the standard pattern and matches how
 * subscription self-service already works (see
 * `SubscriptionPortalIsland.tsx`).
 *
 * Light rate limit: one request per email per 5 minutes, persisted in
 * KV. This keeps the route safe to expose publicly without adding an
 * auth boundary.
 */

import type { PluginContext, RouteContext, StorageCollection } from "emdash";
import type { StripeClientOptions } from "../stripe/client";
import { createBillingPortalSession } from "../stripe/checkout-sessions";
import type { Customer } from "../types";

const RATE_LIMIT_MS = 5 * 60 * 1000;
const rateKey = (email: string) => `state:portalLinkSentAt:${email.toLowerCase()}`;

type CustomersStore = StorageCollection<Customer>;
function customersStore(ctx: PluginContext): CustomersStore {
	return (ctx.storage as unknown as { customers: CustomersStore }).customers;
}

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

function isValidEmail(value: string): boolean {
	// A light sanity check — the real bounce-check is delivery. Accepts
	// anything that has a single @ and a dot after it.
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Resolve a customer by email. Returns null when no match. We look up
 * via the indexed `email` field on the customers collection.
 */
async function findCustomerByEmail(
	ctx: PluginContext,
	email: string,
): Promise<Customer | null> {
	const res = await customersStore(ctx).query({
		where: { email },
		limit: 1,
	});
	const row = res.items[0];
	if (!row) return null;
	return { ...(row.data as Customer), id: row.id };
}

async function handlePortalLink(
	routeCtx: RouteContext,
	_ctx?: PluginContext,
): Promise<Response> {
	const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
	const input = (routeCtx.input ?? {}) as { email?: string; returnUrl?: string };
	const rawEmail = (input.email ?? "").trim().toLowerCase();

	if (!rawEmail || !isValidEmail(rawEmail)) {
		return jsonResponse({ error: "A valid email address is required." }, 400);
	}

	// Per-email cooldown. We respond `sent: true` inside the cooldown
	// window too, so the response shape stays constant.
	const lastRaw = await ctx.kv.get<string>(rateKey(rawEmail));
	if (lastRaw) {
		const last = Date.parse(lastRaw);
		if (Number.isFinite(last) && Date.now() - last < RATE_LIMIT_MS) {
			return jsonResponse({ sent: true });
		}
	}

	const customer = await findCustomerByEmail(ctx, rawEmail);
	if (!customer || !customer.stripeCustomerId) {
		// Nothing we can do — no Stripe customer means no portal can be
		// created. Quietly succeed to avoid leaking account existence.
		return jsonResponse({ sent: true });
	}

	const client = await loadStripeClient(ctx);
	if (!client) {
		ctx.log.warn("Portal link requested but Stripe not configured", {
			email: rawEmail,
		});
		return jsonResponse({ sent: true });
	}

	const origin = new URL(routeCtx.request.url).origin;
	const returnUrl = input.returnUrl ?? `${origin}/account`;

	let portalUrl: string | null = null;
	try {
		const portal = await createBillingPortalSession(
			ctx,
			{ customer: customer.stripeCustomerId, returnUrl },
			client,
			`bp:email:${customer.id}:${Date.now()}`,
		);
		portalUrl = portal.url;
	} catch (err) {
		ctx.log.error("Billing portal session create failed (email-lookup path)", {
			customerId: customer.id,
			error: err instanceof Error ? err.message : String(err),
		});
		// Still respond success so we don't leak provider errors to the
		// client. Merchant can see this in logs.
		return jsonResponse({ sent: true });
	}

	if (!portalUrl) return jsonResponse({ sent: true });

	if (ctx.email) {
		const subject = `Manage your billing on ${ctx.site.name}`;
		const text = [
			`Hi,`,
			"",
			`Here's a secure link to manage your billing — update your card,`,
			`download invoices, and manage any active subscriptions:`,
			"",
			portalUrl,
			"",
			`This link expires shortly for your security. If you didn't request`,
			`it you can safely ignore this email.`,
			"",
			`— ${ctx.site.name}`,
		].join("\n");
		try {
			await ctx.email.send({ to: customer.email, subject, text });
		} catch (err) {
			ctx.log.warn("Portal link email send failed", {
				customerId: customer.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} else {
		// No email provider configured — log the URL so the merchant can
		// retrieve it during local development / self-hosted debugging.
		ctx.log.info("Portal link generated (no email provider configured)", {
			customerId: customer.id,
			portalUrl,
		});
	}

	await ctx.kv.set(rateKey(rawEmail), new Date().toISOString());

	return jsonResponse({ sent: true });
}

export const customerPortalRoutes = {
	"customer/portal-link": { public: true, handler: handlePortalLink },
};

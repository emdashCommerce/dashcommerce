/**
 * Public read-only route: storefront health check.
 *
 *   GET /config-check
 *   →  { stripeSecretConfigured, stripePublishableConfigured,
 *        stripeWebhookConfigured, defaultCurrency, connectEnabled }
 *
 * Used by the storefront to render "you still need to configure X"
 * banners on /checkout and similar pages. Returns booleans only — no
 * key material ever leaves the server, even masked.
 *
 * No authentication: the storefront must be able to read this from
 * unauthenticated page loads, and the shape is non-sensitive (the
 * published/unpublished state of a merchant's Stripe setup is already
 * observable by trying to check out).
 */

import type { PluginContext, RouteContext } from "emdash";

export const configCheckRoutes = {
	"config-check": {
		public: true,
		handler: async (_routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (_routeCtx as unknown as PluginContext)) as PluginContext;
			const [sk, pk, ws, cur, enabled, connect] = await Promise.all([
				ctx.kv.get<string>("settings:stripeSecretKey"),
				ctx.kv.get<string>("settings:stripePublishableKey"),
				ctx.kv.get<string>("settings:stripeWebhookSecret"),
				ctx.kv.get<string>("settings:defaultCurrency"),
				ctx.kv.get<string[]>("settings:enabledCurrencies"),
				ctx.kv.get<boolean>("settings:connectEnabled"),
			]);
			const body = {
				stripeSecretConfigured: Boolean(sk),
				stripePublishableConfigured: Boolean(pk),
				stripeWebhookConfigured: Boolean(ws),
				defaultCurrency: cur ?? null,
				enabledCurrencies: Array.isArray(enabled) ? enabled : cur ? [cur] : [],
				connectEnabled: Boolean(connect),
			};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	},
};

/**
 * DashCommerce (sandboxed): runtime entry.
 *
 * Routes mount under /_emdash/api/plugins/dashcommerce-lite/<name> (the
 * plugin id, `dashcommerce-lite`, is separate from native core's
 * `dashcommerce`).
 * Storefront routes are public, take the cart token in the
 * `X-DashCommerce-Cart` header, and return JSON. See DESIGN.md.
 *
 * Hooks: an hourly `cleanup` cron task is scheduled on install and on
 * activate (see cron.ts).
 */

import { pluginResponse, pluginRoute, type SandboxedPlugin } from "emdash/plugin";
import { handleAdmin } from "./admin";
import {
	addItemHandler,
	CART_HEADER,
	clearCartHandler,
	getCartHandler,
	updateItemHandler,
} from "./cart-routes";
import { createCheckoutHandler } from "./checkout";
import { handleCron, scheduleCleanup } from "./cron";
import { handleExport } from "./export";
import { ordersStore, safeEqual, toPublicOrder } from "./orders";
import { asId, asObject, asString, fail } from "./validate";
import { handleStripeWebhook } from "./webhook";

const JSON_BODY = { body: "json" as const, maxBytes: 16 * 1024, headers: [CART_HEADER] };

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => scheduleCleanup(ctx),
		"plugin:activate": async (_event, ctx) => scheduleCleanup(ctx),
		cron: handleCron,
	},

	routes: {
		cart: pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none", headers: [CART_HEADER] },
			handler: async (routeCtx, ctx) => getCartHandler(ctx, routeCtx.request.headers),
		}),

		"cart/items": pluginRoute({
			public: true,
			methods: ["POST"],
			request: JSON_BODY,
			handler: async (routeCtx, ctx) =>
				addItemHandler(ctx, routeCtx.request.headers, routeCtx.input),
		}),

		"cart/item": pluginRoute({
			public: true,
			methods: ["POST"],
			request: JSON_BODY,
			handler: async (routeCtx, ctx) =>
				updateItemHandler(ctx, routeCtx.request.headers, routeCtx.input),
		}),

		"cart/clear": pluginRoute({
			public: true,
			methods: ["POST"],
			request: JSON_BODY,
			handler: async (routeCtx, ctx) => clearCartHandler(ctx, routeCtx.request.headers),
		}),

		"checkout/session": pluginRoute({
			public: true,
			methods: ["POST"],
			request: JSON_BODY,
			handler: async (routeCtx, ctx) =>
				createCheckoutHandler(ctx, routeCtx.request.headers, routeCtx.input),
		}),

		/** Order status for the success page: GET ?id=<orderId>&key=<orderKey>. */
		order: pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			handler: async (routeCtx, ctx) => {
				const q = asObject(routeCtx.input);
				const id = asId(q.id);
				const key = asString(q.key, 64);
				if (!id || !key) return fail("INVALID_INPUT", "id and key are required");
				const order = await ordersStore(ctx).get(id);
				if (!order || !safeEqual(order.orderKey, key)) {
					return fail("ORDER_NOT_FOUND", "Order not found");
				}
				return { ok: true as const, order: toPublicOrder(id, order) };
			},
		}),

		"stripe/webhook": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "text", maxBytes: 256 * 1024, headers: ["stripe-signature"] },
			response: "raw",
			handler: async (routeCtx, ctx) => {
				const result = await handleStripeWebhook(ctx, routeCtx.input, routeCtx.request.headers);
				return pluginResponse({
					status: result.status,
					headers: { "content-type": "application/json" },
					body: { kind: "text", value: JSON.stringify(result.body) },
				});
			},
		}),

		/**
		 * CSV download for the Orders page. Public because a download link
		 * cannot send the CSRF header private routes need; access needs a
		 * one-time token the admin page mints (see export.ts).
		 */
		"orders/export": pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			handler: async (routeCtx, ctx) => {
				const result = await handleExport(ctx, routeCtx.input);
				return pluginResponse({
					status: result.status,
					headers: result.headers,
					body: { kind: "text", value: result.body },
				});
			},
		}),

		/** Block Kit admin (private; EmDash adds auth and CSRF). */
		admin: {
			handler: async (routeCtx, ctx) => handleAdmin(ctx, routeCtx.input),
		},
	},
};

export default plugin;

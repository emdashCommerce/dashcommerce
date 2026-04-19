/**
 * Public order-lookup routes.
 *
 *   GET /orders/by-draft?id={orderDraftId}
 *     - Polled by the thank-you page after Stripe confirmPayment()
 *       returns. Stripe's webhook + our order-create step can race with
 *       the redirect; the page retries every ~500ms until this returns
 *       `{ status: "ready", order, items }`.
 *     - Returns `{ status: "pending" }` while we're still waiting for
 *       the webhook to land.
 *     - Returns `{ status: "failed" }` if the draft snapshot is gone and
 *       no order was created (Stripe webhook never arrived / PI failed).
 *
 * We don't leak arbitrary orders — access is keyed on `orderDraftId`
 * which only the session that created the PI knows.
 *
 * Why a query string instead of `/orders/by-draft/:id`? emdash's
 * PluginRouteRegistry does an exact-string lookup on the route key — it
 * does NOT parse `:param` placeholders. A literal `:orderDraftId` in the
 * route key would never match a real draft id and every poll would 404.
 */

import type { PluginContext, RouteContext, StorageCollection } from "emdash";
import type { Order, OrderItem } from "../types";
import { draftKey } from "./checkout";

type OrdersStore = StorageCollection<Order>;
type OrderItemsStore = StorageCollection<OrderItem>;

function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}

function orderItemsStore(ctx: PluginContext): OrderItemsStore {
	return (ctx.storage as unknown as { order_items: OrderItemsStore }).order_items;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function parseDraftId(req: Request): string | null {
	const url = new URL(req.url);
	// Preferred: ?id=xxx (what the thank-you island sends).
	const qs = url.searchParams.get("id");
	if (qs) return qs;
	// Legacy fallback: older builds (or direct links) may still use the
	// path-param shape /orders/by-draft/xxx. This won't route here on
	// emdash (no `:param` matching) but the check is cheap and keeps the
	// helper robust for tests / future matchers.
	const parts = url.pathname.split("/").filter(Boolean);
	const idx = parts.lastIndexOf("by-draft");
	return idx === -1 ? null : parts[idx + 1] ?? null;
}

export const ordersPublicRoutes = {
	"orders/by-draft": {
		public: true,
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = (_c ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const orderDraftId = parseDraftId(routeCtx.request);
			if (!orderDraftId) return json({ error: "Missing orderDraftId" }, 400);

			// Query by metadata.orderDraftId — not a first-class index, so we
			// scan the most recent 200 orders (enough for any realistic race
			// window between Stripe confirm + webhook + page poll).
			const recent = await ordersStore(ctx).query({
				orderBy: { createdAt: "desc" },
				limit: 200,
			});
			const match = recent.items.find((r) => {
				const meta = (r.data as Order).metadata as
					| { orderDraftId?: string }
					| undefined;
				return meta?.orderDraftId === orderDraftId;
			});
			if (match) {
				const order = { ...(match.data as Order), id: match.id };
				const items = (
					await orderItemsStore(ctx).query({
						where: { orderId: order.id },
						limit: 200,
					})
				).items.map((r) => ({ ...(r.data as OrderItem), id: r.id }));
				return json({ status: "ready", order, items });
			}

			// No order yet — is the draft snapshot still around?
			const snapshot = await ctx.kv.get<unknown>(draftKey(orderDraftId));
			if (!snapshot) {
				return json({ status: "failed" });
			}
			return json({ status: "pending" });
		},
	},
};

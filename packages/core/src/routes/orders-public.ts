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
 * Access is keyed on `orderDraftId`, but that id travels in the
 * thank-you URL, so treat it as public: the "ready" response is reduced
 * to the fields the thank-you page renders (see toPublicOrder).
 *
 * Why a query string instead of `/orders/by-draft/:id`? emdash's
 * PluginRouteRegistry does an exact-string lookup on the route key — it
 * does NOT parse `:param` placeholders. A literal `:orderDraftId` in the
 * route key would never match a real draft id and every poll would 404.
 */

import type { PluginContext, RouteContext, StorageCollection } from "emdash";
import type { Order, OrderItem } from "../types";
import { orderItemFromStorage } from "../orders/order-item-storage";
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

/**
 * What the public thank-you poll is allowed to return.
 *
 * The route is unauthenticated: anyone holding the draft id (it sits in
 * the thank-you URL, browser history and Referer headers) can call it.
 * So the response carries only what the thank-you page renders: no
 * addresses, Stripe ids, IP, user agent, metadata or vendor splits.
 * The email is masked; the full address is in the receipt email.
 */
export interface PublicOrderSummary {
	id: string;
	orderNumber: string;
	status: Order["status"];
	customerEmail: string;
	currency: Order["currency"];
	total: Order["total"];
}

export interface PublicOrderItem {
	id: string;
	name: string;
	quantity: number;
	total: OrderItem["total"];
}

/** "jane.doe@example.com" → "j***@example.com". */
export function maskEmail(email: string | undefined): string {
	if (!email) return "";
	const at = email.lastIndexOf("@");
	if (at <= 0) return "***";
	return `${email[0]}***${email.slice(at)}`;
}

export function toPublicOrder(order: Order): PublicOrderSummary {
	return {
		id: order.id,
		orderNumber: order.orderNumber,
		status: order.status,
		customerEmail: maskEmail(order.customerEmail),
		currency: order.currency,
		total: order.total,
	};
}

export function toPublicOrderItem(item: OrderItem): PublicOrderItem {
	return {
		id: item.id,
		name: item.name,
		quantity: item.quantity,
		total: item.total,
	};
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
	return idx === -1 ? null : (parts[idx + 1] ?? null);
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
				const meta = (r.data as Order).metadata as { orderDraftId?: string } | undefined;
				return meta?.orderDraftId === orderDraftId;
			});
			if (match) {
				const order = { ...(match.data as Order), id: match.id };
				const items = (
					await orderItemsStore(ctx).query({
						where: { orderId: order.id },
						limit: 200,
					})
				).items.map((r) => toPublicOrderItem(orderItemFromStorage(r.id, r.data as OrderItem)));
				return json({ status: "ready", order: toPublicOrder(order), items });
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

/**
 * Public review routes.
 *
 *   POST /reviews                 — submit
 *      body: { productId, rating, body, customerName, customerEmail, title? }
 *
 *   GET  /reviews/list?productId=…  — approved reviews + summary
 *      ?limit=20&cursor=...
 *
 *   GET  /reviews/item?id=…         — single approved review (used by
 *      the ReviewQuoteBlock Portable Text block).
 *
 * NOTE: Emdash's plugin route registry performs exact-string matches and
 * does not support path parameters, so these endpoints pass the id/productId
 * as query-string parameters. A legacy path fallback is preserved for
 * backward compatibility.
 */

import type { PluginContext, RouteContext } from "emdash";
import { getSummary } from "../reviews/moderate";
import {
	listReviewsForProduct,
	ReviewValidationError,
	submitReview,
} from "../reviews/store";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function handleReviewList(
	ctx: PluginContext,
	routeCtx: RouteContext,
): Promise<Response> {
	const url = new URL(routeCtx.request.url);
	const productId = url.searchParams.get("productId");
	if (!productId) return json({ error: "productId required" }, 400);

	const limit = Math.min(
		100,
		Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
	);
	const cursorParam = url.searchParams.get("cursor");
	const [reviews, summary] = await Promise.all([
		listReviewsForProduct(ctx, productId, {
			status: "approved",
			limit,
			...(cursorParam ? { cursor: cursorParam } : {}),
		}),
		getSummary(ctx, productId),
	]);
	return json({
		reviews: reviews.items,
		cursor: reviews.cursor,
		hasMore: reviews.hasMore,
		summary,
	});
}

async function handleReviewItem(
	ctx: PluginContext,
	routeCtx: RouteContext,
): Promise<Response> {
	const url = new URL(routeCtx.request.url);
	const id = url.searchParams.get("id");
	if (!id) return json({ error: "id required" }, 400);
	const { getReview } = await import("../reviews/store");
	const review = await getReview(ctx, id);
	if (!review || review.status !== "approved") {
		return json({ error: "not_found" }, 404);
	}
	return json({ review });
}

export const reviewsPublicRoutes = {
	reviews: {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const input = (routeCtx.input ?? {}) as {
				productId?: string;
				rating?: number;
				body?: string;
				title?: string;
				customerName?: string;
				customerEmail?: string;
			};
			if (!input.productId || typeof input.rating !== "number" || !input.body) {
				return json(
					{ error: "productId, rating, and body are required" },
					400,
				);
			}
			if (!input.customerName || !input.customerEmail) {
				return json(
					{ error: "customerName and customerEmail are required" },
					400,
				);
			}
			try {
				const review = await submitReview(ctx, {
					productId: input.productId,
					rating: input.rating,
					body: input.body,
					...(input.title ? { title: input.title } : {}),
					customerName: input.customerName,
					customerEmail: input.customerEmail,
				});
				return json({ review });
			} catch (err) {
				if (err instanceof ReviewValidationError) {
					return json({ error: err.message }, 400);
				}
				ctx.log.error("Review submission failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				return json({ error: "Review submission failed" }, 500);
			}
		},
	},

	"reviews/list": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			return handleReviewList(ctx, routeCtx);
		},
	},

	"reviews/item": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			return handleReviewItem(ctx, routeCtx);
		},
	},
};

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
 * List and item are unauthenticated storefront reads, so the JSON is
 * reduced to what ReviewsList / ReviewQuoteBlock render (see
 * toPublicReview). Email, customerId, productId, moderation metadata
 * and any other stored fields stay off the wire.
 *
 * NOTE: Emdash's plugin route registry performs exact-string matches and
 * does not support path parameters, so these endpoints pass the id/productId
 * as query-string parameters. A legacy path fallback is preserved for
 * backward compatibility.
 */

import type { PluginContext, RouteContext } from "emdash";
import { getSummary } from "../reviews/moderate";
import {
	ReviewValidationError,
	getReview,
	listReviewsForProduct,
	submitReview,
} from "../reviews/store";
import type { Review, ReviewSummary } from "../types";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * What the public review list/item endpoints are allowed to return.
 *
 * Matches ReviewsList.astro and ReviewQuoteBlock.astro: stars, title,
 * body, author name, verified-purchase flag, date. Never email.
 */
export interface PublicReview {
	id: string;
	rating: number;
	title?: string;
	body: string;
	customerName: string;
	createdAt: Review["createdAt"];
	verifiedPurchase: boolean;
}

function looksLikeEmail(value: string): boolean {
	return value.includes("@");
}

/** "jane.doe@example.com" → "Jane". Null when the local part is unusable. */
function firstNameFromEmail(email: string): string | null {
	const at = email.indexOf("@");
	if (at <= 0) return null;
	const local = email.slice(0, at);
	const token = (local.split(/[._+\-]/)[0] ?? "").replace(/[^A-Za-z]/g, "");
	if (token.length < 2) return null;
	return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * Storefront author label. Prefer the submitted display name; if that
 * is missing or is itself an email, derive a first name from the
 * address; otherwise "Verified buyer" / "Customer". Never returns the
 * email.
 */
export function publicReviewAuthorName(review: {
	customerName?: string;
	customerEmail?: string;
	verifiedPurchase?: boolean;
}): string {
	const name = review.customerName?.trim() ?? "";
	if (name && !looksLikeEmail(name)) return name;

	const emailish = looksLikeEmail(name) ? name : (review.customerEmail ?? "");
	const derived = firstNameFromEmail(emailish);
	if (derived) return derived;
	return review.verifiedPurchase ? "Verified buyer" : "Customer";
}

export function toPublicReview(review: Review): PublicReview {
	const out: PublicReview = {
		id: review.id,
		rating: review.rating,
		body: review.body,
		customerName: publicReviewAuthorName(review),
		createdAt: review.createdAt,
		verifiedPurchase: review.verifiedPurchase,
	};
	if (review.title) out.title = review.title;
	return out;
}

/** Aggregate stars/count only — no productId or timestamps. */
export interface PublicReviewSummary {
	averageRating: number;
	count: number;
	distribution: ReviewSummary["distribution"];
}

export function toPublicReviewSummary(summary: ReviewSummary | null): PublicReviewSummary | null {
	if (!summary) return null;
	return {
		averageRating: summary.averageRating,
		count: summary.count,
		distribution: summary.distribution,
	};
}

async function handleReviewList(ctx: PluginContext, routeCtx: RouteContext): Promise<Response> {
	const url = new URL(routeCtx.request.url);
	const productId = url.searchParams.get("productId");
	if (!productId) return json({ error: "productId required" }, 400);

	const limit = Math.min(100, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20);
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
		reviews: reviews.items.map(toPublicReview),
		cursor: reviews.cursor,
		hasMore: reviews.hasMore,
		summary: toPublicReviewSummary(summary),
	});
}

async function handleReviewItem(ctx: PluginContext, routeCtx: RouteContext): Promise<Response> {
	const url = new URL(routeCtx.request.url);
	const id = url.searchParams.get("id");
	if (!id) return json({ error: "id required" }, 400);
	const review = await getReview(ctx, id);
	if (!review || review.status !== "approved") {
		return json({ error: "not_found" }, 404);
	}
	return json({ review: toPublicReview(review) });
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
				return json({ error: "productId, rating, and body are required" }, 400);
			}
			if (!input.customerName || !input.customerEmail) {
				return json({ error: "customerName and customerEmail are required" }, 400);
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
				return json({ review: toPublicReview(review) });
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

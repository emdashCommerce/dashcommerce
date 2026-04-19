/**
 * Review moderation + summary aggregation.
 *
 * Moderation is a simple status transition: pending → approved | rejected |
 * spam. On every approve/reject change that affects a product's approved
 * set, we recompute its `ReviewSummary` — a denormalized aggregate read
 * directly by product card renderers for speed.
 *
 * Summaries key on productId (put as id). The `review_summaries`
 * collection is indexed by `updatedAt` to support a "recently reviewed"
 * feed later.
 */

import type { PluginContext, StorageCollection } from "emdash";
import type { Review, ReviewSummary, ReviewStatus } from "../types";
import { getReview, reviewsStore } from "./store";

type SummaryStore = StorageCollection<ReviewSummary>;

function summaryStore(ctx: PluginContext): SummaryStore {
	return (ctx.storage as unknown as { review_summaries: SummaryStore }).review_summaries;
}

export async function moderateReview(
	ctx: PluginContext,
	reviewId: string,
	nextStatus: ReviewStatus,
	moderatedByUserId?: string,
): Promise<Review> {
	const review = await getReview(ctx, reviewId);
	if (!review) throw new Error(`Review ${reviewId} not found`);
	if (review.status === nextStatus) return review;

	const now = new Date().toISOString();
	const updated: Review = {
		...review,
		status: nextStatus,
		// Reverting to pending clears the moderation metadata so the review
		// looks untouched in the pending queue.
		...(nextStatus === "pending"
			? { moderatedAt: undefined, moderatedByUserId: undefined }
			: {
					moderatedAt: now,
					...(moderatedByUserId ? { moderatedByUserId } : {}),
				}),
	};
	await reviewsStore(ctx).put(review.id, updated);
	// Refresh summary whenever the approved pool might change.
	if (review.status === "approved" || nextStatus === "approved") {
		await recomputeSummary(ctx, review.productId);
	}
	return updated;
}

export async function recomputeSummary(
	ctx: PluginContext,
	productId: string,
): Promise<ReviewSummary> {
	let cursor: string | undefined;
	let total = 0;
	let count = 0;
	const distribution: Record<1 | 2 | 3 | 4 | 5, number> = {
		1: 0,
		2: 0,
		3: 0,
		4: 0,
		5: 0,
	};
	// Iterate all approved reviews for this product. Page at 100 each.
	// Most products will never cross this cap; at that scale we'd push
	// summary computation into a background job anyway.
	while (true) {
		const page = await reviewsStore(ctx).query({
			where: { productId, status: "approved" },
			limit: 100,
			cursor,
		});
		for (const row of page.items) {
			const r = row.data as Review;
			if (r.rating < 1 || r.rating > 5) continue;
			const bucket = r.rating as 1 | 2 | 3 | 4 | 5;
			distribution[bucket] += 1;
			total += r.rating;
			count += 1;
		}
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}

	const summary: ReviewSummary = {
		productId,
		averageRating: count === 0 ? 0 : Math.round((total / count) * 100) / 100,
		count,
		distribution,
		updatedAt: new Date().toISOString(),
	};
	await summaryStore(ctx).put(productId, summary);
	return summary;
}

export async function getSummary(
	ctx: PluginContext,
	productId: string,
): Promise<ReviewSummary | null> {
	const raw = await summaryStore(ctx).get(productId);
	if (!raw) return null;
	return { ...(raw as ReviewSummary), productId };
}

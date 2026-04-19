/**
 * Review storage — CRUD against `ctx.storage.reviews`.
 *
 * Reviews can be submitted by anyone whose email we have, gated by two
 * settings:
 *
 *   settings:reviewsRequireApproval   (default true)  — status starts as
 *                                                       "pending" and must
 *                                                       be moderated.
 *   settings:reviewsRequirePurchase  (default false)  — the submitting
 *                                                       email must have a
 *                                                       paid order that
 *                                                       contained the
 *                                                       product.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import type { Order, OrderItem, Review } from "../types";

type ReviewStore = StorageCollection<Review>;
type OrdersStore = StorageCollection<Order>;
type OrderItemsStore = StorageCollection<OrderItem>;

export function reviewsStore(ctx: PluginContext): ReviewStore {
	return (ctx.storage as unknown as { reviews: ReviewStore }).reviews;
}
function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}
function orderItemsStore(ctx: PluginContext): OrderItemsStore {
	return (ctx.storage as unknown as { order_items: OrderItemsStore }).order_items;
}

export async function readRequireApproval(ctx: PluginContext): Promise<boolean> {
	const v = await ctx.kv.get<boolean>("settings:reviewsRequireApproval");
	return v === undefined || v === null ? true : v;
}

export async function readRequirePurchase(ctx: PluginContext): Promise<boolean> {
	return (await ctx.kv.get<boolean>("settings:reviewsRequirePurchase")) ?? false;
}

export async function hasVerifiedPurchase(
	ctx: PluginContext,
	customerEmail: string,
	productId: string,
): Promise<boolean> {
	const orders = await ordersStore(ctx).query({
		where: { paymentStatus: "paid" },
		limit: 100,
	});
	for (const row of orders.items) {
		const o = row.data as Order;
		if (o.customerEmail.toLowerCase() !== customerEmail.toLowerCase()) continue;
		const items = await orderItemsStore(ctx).query({
			where: { orderId: o.id },
			limit: 50,
		});
		for (const itRow of items.items) {
			const it = itRow.data as OrderItem;
			if (it.productId === productId) return true;
		}
	}
	return false;
}

export interface SubmitReviewInput {
	productId: string;
	customerName: string;
	customerEmail: string;
	rating: number;
	title?: string;
	body: string;
	customerId?: string;
}

export class ReviewValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewValidationError";
	}
}

export async function submitReview(
	ctx: PluginContext,
	input: SubmitReviewInput,
): Promise<Review> {
	const rating = Math.round(input.rating);
	if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
		throw new ReviewValidationError("Rating must be an integer between 1 and 5.");
	}
	if (!input.body || input.body.trim().length < 3) {
		throw new ReviewValidationError("Review body is too short.");
	}
	if (!input.customerEmail.includes("@")) {
		throw new ReviewValidationError("A valid email is required.");
	}
	if (!input.customerName.trim()) {
		throw new ReviewValidationError("Name is required.");
	}

	const verified = await hasVerifiedPurchase(
		ctx,
		input.customerEmail,
		input.productId,
	);
	if ((await readRequirePurchase(ctx)) && !verified) {
		throw new ReviewValidationError(
			"Reviews on this site are limited to verified purchasers.",
		);
	}

	const initialStatus: Review["status"] = (await readRequireApproval(ctx))
		? "pending"
		: "approved";

	const now = new Date().toISOString();
	const review: Review = {
		id: randomId(),
		productId: input.productId,
		customerEmail: input.customerEmail.toLowerCase(),
		customerName: input.customerName.trim(),
		rating,
		...(input.title ? { title: input.title.trim() } : {}),
		body: input.body.trim(),
		status: initialStatus,
		verifiedPurchase: verified,
		...(input.customerId ? { customerId: input.customerId } : {}),
		createdAt: now,
		...(initialStatus === "approved" ? { moderatedAt: now } : {}),
	};
	await reviewsStore(ctx).put(review.id, review);
	return review;
}

export async function listReviewsForProduct(
	ctx: PluginContext,
	productId: string,
	opts: {
		status?: Review["status"];
		limit?: number;
		cursor?: string;
	} = {},
): Promise<{ items: Review[]; cursor?: string; hasMore: boolean }> {
	const where: Record<string, string | number | boolean | null> = { productId };
	if (opts.status) where.status = opts.status;
	const result = await reviewsStore(ctx).query({
		where,
		orderBy: { createdAt: "desc" },
		limit: opts.limit ?? 20,
		cursor: opts.cursor,
	});
	return {
		items: result.items.map((r) => ({ ...(r.data as Review), id: r.id })),
		cursor: result.cursor,
		hasMore: result.hasMore,
	};
}

export async function getReview(ctx: PluginContext, id: string): Promise<Review | null> {
	const raw = await reviewsStore(ctx).get(id);
	if (!raw) return null;
	return { ...(raw as Review), id };
}

export async function listPending(
	ctx: PluginContext,
	opts: { limit?: number; cursor?: string } = {},
): Promise<{ items: Review[]; cursor?: string; hasMore: boolean }> {
	const result = await reviewsStore(ctx).query({
		where: { status: "pending" },
		orderBy: { createdAt: "asc" },
		limit: opts.limit ?? 50,
		cursor: opts.cursor,
	});
	return {
		items: result.items.map((r) => ({ ...(r.data as Review), id: r.id })),
		cursor: result.cursor,
		hasMore: result.hasMore,
	};
}

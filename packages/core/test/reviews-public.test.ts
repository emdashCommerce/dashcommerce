import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	publicReviewAuthorName,
	reviewsPublicRoutes,
	toPublicReview,
} from "../src/routes/reviews-public";
import type { Review } from "../src/types";

/**
 * Regression tests: public /reviews/list and /reviews/item must not
 * return the stored review (email, customerId, moderation metadata).
 */

const EMAIL = "jane.doe@secret.test";

const storedReview: Review = {
	id: "rev_1",
	productId: "prod_secret",
	customerId: "cus_internal_1",
	customerEmail: EMAIL,
	customerName: "Ada Lovelace",
	rating: 5,
	title: "Worth every penny",
	body: "The leather held up on a wet commute.",
	status: "approved",
	verifiedPurchase: true,
	createdAt: "2026-11-14T00:00:00.000Z",
	moderatedAt: "2026-11-14T01:00:00.000Z",
	moderatedByUserId: "admin_secret",
};

const summary = {
	productId: "prod_secret",
	averageRating: 5,
	count: 1,
	distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
	updatedAt: "2026-11-14T01:00:00.000Z",
};

function ctxWithReview(review: Review = storedReview): PluginContext {
	return {
		storage: {
			reviews: {
				query: async () => ({
					items: [{ id: review.id, data: review }],
					cursor: "c_next",
					hasMore: true,
				}),
				get: async (id: string) => (id === review.id ? review : null),
				put: async () => {},
			},
			review_summaries: {
				get: async () => summary,
			},
			orders: {
				query: async () => ({ items: [], cursor: null, hasMore: false }),
			},
			order_items: {
				query: async () => ({ items: [], cursor: null, hasMore: false }),
			},
		},
		kv: {
			get: async (key: string) => {
				if (key === "settings:reviewsRequireApproval") return true;
				if (key === "settings:reviewsRequirePurchase") return false;
				return null;
			},
		},
		log: { error() {}, warn() {}, info() {}, debug() {} },
	} as unknown as PluginContext;
}

async function list(ctx: PluginContext) {
	const req = new Request(
		"http://localhost/_emdash/api/plugins/dashcommerce/reviews/list?productId=prod_secret",
	);
	const res = await reviewsPublicRoutes["reviews/list"].handler(
		{ request: req } as RouteContext,
		ctx,
	);
	return res;
}

async function item(ctx: PluginContext, id = "rev_1") {
	const req = new Request(
		`http://localhost/_emdash/api/plugins/dashcommerce/reviews/item?id=${id}`,
	);
	const res = await reviewsPublicRoutes["reviews/item"].handler(
		{ request: req } as RouteContext,
		ctx,
	);
	return res;
}

const publicShape = {
	id: "rev_1",
	rating: 5,
	title: "Worth every penny",
	body: "The leather held up on a wet commute.",
	customerName: "Ada Lovelace",
	createdAt: "2026-11-14T00:00:00.000Z",
	verifiedPurchase: true,
};

const secrets = [
	EMAIL,
	"jane.doe",
	"secret.test",
	"cus_internal_1",
	"prod_secret",
	"admin_secret",
	"approved",
	"moderated",
];

describe("GET /reviews/list (public shape)", () => {
	it("returns only the storefront review fields", async () => {
		const res = await list(ctxWithReview());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			reviews: Record<string, unknown>[];
			cursor?: string;
			hasMore: boolean;
			summary: { averageRating: number; count: number };
		};
		expect(body.reviews).toEqual([publicShape]);
		expect(body.cursor).toBe("c_next");
		expect(body.hasMore).toBe(true);
		expect(body.summary).toEqual({
			averageRating: 5,
			count: 1,
			distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
		});
	});

	it("leaks none of the sensitive stored values", async () => {
		const raw = JSON.stringify(await (await list(ctxWithReview())).json());
		for (const secret of secrets) {
			expect(raw).not.toContain(secret);
		}
	});
});

describe("GET /reviews/item (public shape)", () => {
	it("returns only the storefront review fields", async () => {
		const res = await item(ctxWithReview());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { review: Record<string, unknown> };
		expect(body.review).toEqual(publicShape);
	});

	it("leaks none of the sensitive stored values", async () => {
		const raw = JSON.stringify(await (await item(ctxWithReview())).json());
		for (const secret of secrets) {
			expect(raw).not.toContain(secret);
		}
	});

	it("404s unapproved reviews without echoing the stored row", async () => {
		const pending: Review = { ...storedReview, status: "pending" };
		const res = await item(ctxWithReview(pending));
		expect(res.status).toBe(404);
		const raw = JSON.stringify(await res.json());
		expect(raw).toContain("not_found");
		for (const secret of secrets) {
			expect(raw).not.toContain(secret);
		}
	});
});

describe("POST /reviews", () => {
	it("echoes the public shape, not the stored email", async () => {
		const res = await reviewsPublicRoutes.reviews.handler(
			{
				request: new Request("http://localhost/_emdash/api/plugins/dashcommerce/reviews", {
					method: "POST",
				}),
				input: {
					productId: "prod_1",
					rating: 4,
					body: "Solid build.",
					title: "Nice",
					customerName: "Ada Lovelace",
					customerEmail: EMAIL,
				},
			} as RouteContext,
			ctxWithReview(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { review: Record<string, unknown> };
		expect(body.review.customerName).toBe("Ada Lovelace");
		expect(body.review.rating).toBe(4);
		expect(body.review.body).toBe("Solid build.");
		expect(body.review).not.toHaveProperty("customerEmail");
		expect(body.review).not.toHaveProperty("customerId");
		expect(body.review).not.toHaveProperty("status");
		const raw = JSON.stringify(body);
		expect(raw).not.toContain(EMAIL);
		expect(raw).not.toContain("secret.test");
	});
});

describe("publicReviewAuthorName", () => {
	it("keeps a real display name", () => {
		expect(
			publicReviewAuthorName({
				customerName: "Ada Lovelace",
				customerEmail: EMAIL,
				verifiedPurchase: true,
			}),
		).toBe("Ada Lovelace");
	});

	it("derives a first name when the name is missing", () => {
		expect(
			publicReviewAuthorName({
				customerName: "",
				customerEmail: EMAIL,
				verifiedPurchase: true,
			}),
		).toBe("Jane");
	});

	it("does not treat an email as a display name", () => {
		expect(
			publicReviewAuthorName({
				customerName: EMAIL,
				customerEmail: EMAIL,
				verifiedPurchase: true,
			}),
		).toBe("Jane");
	});

	it("falls back to Verified buyer / Customer", () => {
		expect(
			publicReviewAuthorName({
				customerName: "",
				customerEmail: "x@y.z",
				verifiedPurchase: true,
			}),
		).toBe("Verified buyer");
		expect(
			publicReviewAuthorName({
				customerName: "   ",
				verifiedPurchase: false,
			}),
		).toBe("Customer");
	});
});

describe("toPublicReview", () => {
	it("omits title when absent", () => {
		const publicReview = toPublicReview({ ...storedReview, title: undefined });
		expect(publicReview).not.toHaveProperty("title");
		expect(publicReview.customerName).toBe("Ada Lovelace");
	});
});

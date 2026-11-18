import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	subscriptionsPublicRoutes,
	toPublicSubscription,
} from "../src/routes/subscriptions-public";
import { issueToken } from "../src/subscriptions/tokens";
import type { Subscription } from "../src/types";

/**
 * Regression tests: token-gated /subscriptions/state must not return
 * the stored Subscription (Stripe ids, customerId, productId).
 */

const SECRET = "ab".repeat(32);
const STRIPE_SUB = "sub_stripe_secret";
const CUSTOMER = "cus_internal_secret";

const storedSub: Subscription = {
	id: "sub_local",
	stripeSubscriptionId: STRIPE_SUB,
	customerId: CUSTOMER,
	productId: "prod_secret",
	variantId: "var_secret",
	status: "active",
	currency: "USD",
	unitAmount: { currency: "USD", amount: 2500 },
	quantity: 2,
	interval: "month",
	intervalCount: 1,
	trialEndsAt: "2026-10-15T00:00:00.000Z",
	currentPeriodStart: "2026-11-01T00:00:00.000Z",
	currentPeriodEnd: "2026-12-01T00:00:00.000Z",
	cancelAtPeriodEnd: false,
	canceledAt: undefined,
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-11-14T00:00:00.000Z",
};

function ctxWithSub(opts: { stripeConfigured?: boolean } = {}): PluginContext {
	const stripeConfigured = opts.stripeConfigured ?? true;
	return {
		storage: {
			subscriptions: {
				query: async (q: { where?: { stripeSubscriptionId?: string } }) => {
					if (q.where?.stripeSubscriptionId === STRIPE_SUB) {
						return {
							items: [{ id: storedSub.id, data: storedSub }],
							cursor: null,
							hasMore: false,
						};
					}
					return { items: [], cursor: null, hasMore: false };
				},
				get: async (id: string) => (id === storedSub.id ? storedSub : null),
			},
		},
		kv: {
			get: async (key: string) => {
				if (key === "state:subscriptionSigningSecret") return SECRET;
				if (key === "settings:stripeSecretKey") {
					return stripeConfigured ? "sk_test_secret" : null;
				}
				return null;
			},
			set: async () => {},
		},
		log: { error() {}, warn() {}, info() {}, debug() {} },
	} as unknown as PluginContext;
}

async function tokenFor(ctx: PluginContext): Promise<string> {
	return issueToken(ctx, { subscriptionId: STRIPE_SUB, ttlMs: 60_000 });
}

async function state(ctx: PluginContext, token: string) {
	const req = new Request(
		`http://localhost/_emdash/api/plugins/dashcommerce/subscriptions/state?token=${encodeURIComponent(token)}`,
	);
	return subscriptionsPublicRoutes["subscriptions/state"].handler(
		{ request: req } as RouteContext,
		ctx,
	);
}

const secrets = [
	STRIPE_SUB,
	CUSTOMER,
	"prod_secret",
	"var_secret",
	"sk_test_secret",
	"2026-09-01T00:00:00.000Z",
	"2026-10-15T00:00:00.000Z",
	"2026-11-01T00:00:00.000Z",
	"2026-11-14T00:00:00.000Z",
];

describe("GET /subscriptions/state (public shape)", () => {
	it("returns only the portal island fields", async () => {
		const ctx = ctxWithSub();
		const token = await tokenFor(ctx);
		const res = await state(ctx, token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { subscription: Record<string, unknown> };
		expect(body.subscription).toEqual({
			id: "sub_local",
			status: "active",
			currency: "USD",
			unitAmount: { currency: "USD", amount: 2500 },
			interval: "month",
			intervalCount: 1,
			currentPeriodEnd: "2026-12-01T00:00:00.000Z",
			cancelAtPeriodEnd: false,
		});
	});

	it("leaks none of the sensitive stored values", async () => {
		const ctx = ctxWithSub();
		const token = await tokenFor(ctx);
		const raw = JSON.stringify(await (await state(ctx, token)).json());
		for (const secret of secrets) {
			expect(raw).not.toContain(secret);
		}
	});

	it("still rejects a missing or invalid token", async () => {
		const ctx = ctxWithSub();
		const missing = await state(ctx, "");
		expect(missing.status).toBe(400);

		const bad = await state(ctx, "not.a.token");
		expect(bad.status).toBe(401);
		const raw = JSON.stringify(await bad.json());
		for (const secret of secrets) {
			expect(raw).not.toContain(secret);
		}
	});
});

describe("subscription mutation routes", () => {
	it("cancel/pause/resume still require a valid token and do not echo Stripe ids", async () => {
		const ctx = ctxWithSub({ stripeConfigured: false });
		const token = await tokenFor(ctx);
		for (const action of ["cancel", "pause", "resume"] as const) {
			const res = await subscriptionsPublicRoutes[`subscriptions/${action}`].handler(
				{
					request: new Request(
						`http://localhost/_emdash/api/plugins/dashcommerce/subscriptions/${action}`,
						{ method: "POST" },
					),
					input: { token },
				} as RouteContext,
				ctx,
			);
			expect(res.status).toBe(500);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toMatch(/Stripe not configured/i);
			expect(body).not.toHaveProperty("stripeSubscriptionId");
			expect(body).not.toHaveProperty("subscription");
			const raw = JSON.stringify(body);
			expect(raw).not.toContain(STRIPE_SUB);
			expect(raw).not.toContain(CUSTOMER);
		}
	});

	it("cancel without a token is 400", async () => {
		const res = await subscriptionsPublicRoutes["subscriptions/cancel"].handler(
			{
				request: new Request(
					"http://localhost/_emdash/api/plugins/dashcommerce/subscriptions/cancel",
					{ method: "POST" },
				),
				input: {},
			} as RouteContext,
			ctxWithSub(),
		);
		expect(res.status).toBe(400);
	});
});

describe("toPublicSubscription", () => {
	it("pins the allowlisted keys", () => {
		expect(Object.keys(toPublicSubscription(storedSub)).sort()).toEqual(
			[
				"cancelAtPeriodEnd",
				"currency",
				"currentPeriodEnd",
				"id",
				"interval",
				"intervalCount",
				"status",
				"unitAmount",
			].sort(),
		);
	});
});

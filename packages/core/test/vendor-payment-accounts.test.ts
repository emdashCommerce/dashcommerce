import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
import type { Vendor } from "../src/types";
import { makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

function splitsProvider() {
	return {
		...createMockPaymentProvider({ id: "flw" }),
		label: "Flutterwave",
		capabilities: { splits: true },
	};
}

function vendor(id: string, overrides: Partial<Vendor> = {}): Vendor {
	return {
		id,
		name: `Vendor ${id}`,
		email: `${id}@example.com`,
		onboardingStatus: "pending",
		platformFeePercent: 0,
		detailsSubmitted: false,
		chargesEnabled: false,
		payoutsEnabled: false,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

async function call(
	ctx: PluginContext,
	route: "admin/vendors" | "admin/vendors/item",
	method: "GET" | "POST" | "PATCH",
	input?: Record<string, unknown>,
	url = `http://test/${route}`,
) {
	const routeCtx = {
		request: new Request(url, { method }),
		input,
	} as unknown as RouteContext;
	const res = (await adminApiRoutes[route].handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("vendor routes without Stripe Connect", () => {
	it("are refused when no split-capable provider is registered", async () => {
		const { ctx } = makeRouteContext({});
		const res = await call(ctx, "admin/vendors", "GET");
		expect(res.status).toBe(409);
		expect(res.body.error).toBe("marketplace_disabled");
	});

	it("open when a provider declares capabilities.splits", async () => {
		registerPaymentProvider(splitsProvider());
		const { ctx } = makeRouteContext({});
		const res = await call(ctx, "admin/vendors", "GET");
		expect(res.status).toBe(200);
		expect(res.body.items).toEqual([]);
	});

	it("exposes provider capabilities to the Vendors page", async () => {
		registerPaymentProvider(splitsProvider());
		const { ctx } = makeRouteContext({});
		const routeCtx = {
			request: new Request("http://test/admin/settings", { method: "GET" }),
		} as unknown as RouteContext;
		const res = (await adminApiRoutes["admin/settings"].handler(routeCtx, ctx)) as Response;
		const body = (await res.json()) as {
			_providers: Array<{ id: string; capabilities?: Record<string, unknown> }>;
		};
		const row = body._providers.find((provider) => provider.id === "flw");
		expect(row?.capabilities).toEqual({ splits: true });
	});
});

describe("creating a vendor with a provider account", () => {
	it("creates a Flutterwave vendor and marks it active", async () => {
		registerPaymentProvider(splitsProvider());
		const { ctx, getCol } = makeRouteContext({});
		const res = await call(ctx, "admin/vendors/item", "POST", {
			name: "Acme Widgets",
			email: "ops@acme.example",
			platformFeePercent: 5,
			paymentAccount: {
				providerId: "flw",
				accountReference: "RS_ABC123",
				status: "active",
			},
		});
		expect(res.status).toBe(201);
		const created = res.body.vendor as Vendor;
		expect(created.onboardingStatus).toBe("active");
		expect(created.paymentAccounts?.flw).toMatchObject({
			accountReference: "RS_ABC123",
			status: "active",
		});
		expect(created).not.toHaveProperty("stripeAccountId");
		expect(getCol("vendors").size).toBe(1);
	});

	it("creates more than one vendor without a Stripe account", async () => {
		registerPaymentProvider(splitsProvider());
		const { ctx, getCol } = makeRouteContext({ "settings:flwSecretKey": "test-key" });
		const first = await call(ctx, "admin/vendors/item", "POST", {
			name: "Vendor A",
			email: "a@example.com",
		});
		const second = await call(ctx, "admin/vendors/item", "POST", {
			name: "Vendor B",
			email: "b@example.com",
		});
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(getCol("vendors").size).toBe(2);
		for (const row of getCol("vendors").values()) {
			expect(row).not.toHaveProperty("stripeAccountId");
		}
	});

	it("rejects an unknown provider, a non-splitting provider and a bad reference", async () => {
		registerPaymentProvider(splitsProvider());
		registerPaymentProvider(createMockPaymentProvider({ id: "plain" }));
		const { ctx, getCol } = makeRouteContext({});

		const unknown = await call(ctx, "admin/vendors/item", "POST", {
			name: "Acme",
			email: "ops@acme.example",
			paymentAccount: { providerId: "ghost", accountReference: "RS_ABC123" },
		});
		expect(unknown.status).toBe(400);
		expect(String(unknown.body.error)).toContain("Unknown payment provider");

		const noSplit = await call(ctx, "admin/vendors/item", "POST", {
			name: "Acme",
			email: "ops@acme.example",
			paymentAccount: { providerId: "plain", accountReference: "RS_ABC123" },
		});
		expect(noSplit.status).toBe(400);
		expect(String(noSplit.body.error)).toContain("does not support split payments");

		const badRef = await call(ctx, "admin/vendors/item", "POST", {
			name: "Acme",
			email: "ops@acme.example",
			paymentAccount: { providerId: "flw", accountReference: "has a space" },
		});
		expect(badRef.status).toBe(400);

		const badStatus = await call(ctx, "admin/vendors/item", "POST", {
			name: "Acme",
			email: "ops@acme.example",
			paymentAccount: {
				providerId: "flw",
				accountReference: "RS_ABC123",
				status: "weird",
			},
		});
		expect(badStatus.status).toBe(400);
		expect(getCol("vendors").size).toBe(0);
	});
});

describe("patching a vendor's provider account", () => {
	it("adds, replaces and removes the account", async () => {
		registerPaymentProvider(splitsProvider());
		const { ctx, getCol } = makeRouteContext({});
		getCol("vendors").set("v1", vendor("v1"));

		const added = await call(
			ctx,
			"admin/vendors/item",
			"PATCH",
			{
				paymentAccount: {
					providerId: "flw",
					accountReference: "RS_FIRST",
					status: "active",
				},
			},
			"http://test/admin/vendors/item?id=v1",
		);
		expect(added.status).toBe(200);
		expect((added.body.vendor as Vendor).paymentAccounts?.flw?.accountReference).toBe("RS_FIRST");
		expect((added.body.vendor as Vendor).onboardingStatus).toBe("active");

		const replaced = await call(
			ctx,
			"admin/vendors/item",
			"PATCH",
			{
				paymentAccounts: [
					{
						providerId: "flw",
						accountReference: "RS_SECOND",
						status: "active",
					},
				],
			},
			"http://test/admin/vendors/item?id=v1",
		);
		expect((replaced.body.vendor as Vendor).paymentAccounts?.flw?.accountReference).toBe(
			"RS_SECOND",
		);

		const removed = await call(
			ctx,
			"admin/vendors/item",
			"PATCH",
			{
				paymentAccount: { providerId: "flw", accountReference: null },
			},
			"http://test/admin/vendors/item?id=v1",
		);
		expect((removed.body.vendor as Vendor).paymentAccounts).toBeUndefined();
		expect((removed.body.vendor as Vendor).onboardingStatus).toBe("pending");
	});

	it("does not change a Stripe vendor's onboarding status", async () => {
		registerPaymentProvider(splitsProvider());
		const { ctx, getCol } = makeRouteContext({});
		getCol("vendors").set(
			"v1",
			vendor("v1", {
				stripeAccountId: "acct_123",
				onboardingStatus: "restricted",
			}),
		);

		const res = await call(
			ctx,
			"admin/vendors/item",
			"PATCH",
			{
				paymentAccount: {
					providerId: "flw",
					accountReference: "RS_ABC123",
					status: "active",
				},
			},
			"http://test/admin/vendors/item?id=v1",
		);
		expect(res.status).toBe(200);
		expect((res.body.vendor as Vendor).onboardingStatus).toBe("restricted");
	});
});

describe("listing vendors", () => {
	it("finds a vendor by its provider account reference", async () => {
		registerPaymentProvider(splitsProvider());
		const { ctx, getCol } = makeRouteContext({});
		getCol("vendors").set(
			"v1",
			vendor("v1", {
				paymentAccounts: {
					flw: {
						accountReference: "RS_SEARCHME",
						status: "active",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				},
			}),
		);
		const res = await call(
			ctx,
			"admin/vendors",
			"GET",
			undefined,
			"http://test/admin/vendors?q=searchme",
		);
		expect(res.status).toBe(200);
		expect((res.body.items as Vendor[]).map((v) => v.id)).toEqual(["v1"]);
	});
});

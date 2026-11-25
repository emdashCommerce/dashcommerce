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

function onboardingProvider() {
	return {
		...createMockPaymentProvider({ id: "flw" }),
		label: "Flutterwave",
		capabilities: { splits: true },
		async listPayoutBanks(_ctx: unknown, country: string) {
			return [{ code: "044", name: `Access Bank ${country}` }];
		},
		async resolvePayoutAccount(_ctx: unknown, input: { accountNumber: string }) {
			return { accountName: `Name for ${input.accountNumber}` };
		},
		async createPayoutAccount(
			_ctx: unknown,
			input: {
				accountNumber: string;
				bankCode: string;
				country: string;
			},
		) {
			return {
				accountReference: "RS_TEST",
				accountName: `Name for ${input.accountNumber}`,
				bankName: "Access Bank",
				bankCode: input.bankCode,
				country: input.country,
				maskedAccountNumber: `••••${input.accountNumber.slice(-4)}`,
				metadata: { providerAccountId: "123" },
			};
		},
	};
}

function vendor(overrides: Partial<Vendor> = {}): Vendor {
	return {
		id: "v1",
		name: "Vendor One",
		email: "v1@example.com",
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
	route: string,
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

const createInput = {
	providerId: "flw",
	vendorId: "v1",
	accountNumber: "0690000031",
	bankCode: "044",
	country: "NG",
	businessName: "Vendor One",
	businessEmail: "v1@example.com",
	businessMobile: "09087930450",
	splitType: "percentage",
	splitValue: 0.1,
};

describe("provider payout onboarding", () => {
	it("lists banks and resolves an account name", async () => {
		registerPaymentProvider(onboardingProvider());
		const { ctx } = makeRouteContext({ "settings:flwSecretKey": "test-key" });
		const banks = await call(
			ctx,
			"admin/vendors/payout-banks",
			"GET",
			undefined,
			"http://test/admin/vendors/payout-banks?provider=flw&country=NG",
		);
		expect(banks.status).toBe(200);
		expect(banks.body.banks).toEqual([{ code: "044", name: "Access Bank NG" }]);

		const resolved = await call(ctx, "admin/vendors/payout-account/resolve", "POST", {
			providerId: "flw",
			accountNumber: "0690000031",
			bankCode: "044",
		});
		expect(resolved.status).toBe(200);
		expect(resolved.body.accountName).toBe("Name for 0690000031");
	});

	it("creates the account, stores the verified metadata and activates the vendor", async () => {
		registerPaymentProvider(onboardingProvider());
		const { ctx, getCol } = makeRouteContext({ "settings:flwSecretKey": "test-key" });
		getCol("vendors").set("v1", vendor());

		const res = await call(ctx, "admin/vendors/payout-account", "POST", createInput);
		expect(res.status).toBe(201);
		const saved = res.body.vendor as Vendor;
		expect(saved.paymentAccounts?.flw).toMatchObject({
			accountReference: "RS_TEST",
			status: "active",
			accountName: "Name for 0690000031",
			bankName: "Access Bank",
			bankCode: "044",
			country: "NG",
			maskedAccountNumber: "••••0031",
			metadata: { providerAccountId: "123" },
		});
		expect(saved.onboardingStatus).toBe("active");
		expect((getCol("vendors").get("v1") as Vendor).paymentAccounts?.flw?.accountReference).toBe(
			"RS_TEST",
		);
	});

	it("refuses a second account unless replace is true", async () => {
		registerPaymentProvider(onboardingProvider());
		const { ctx, getCol } = makeRouteContext({ "settings:flwSecretKey": "test-key" });
		getCol("vendors").set(
			"v1",
			vendor({
				paymentAccounts: {
					flw: {
						accountReference: "RS_OLD",
						status: "active",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				},
			}),
		);

		const refused = await call(ctx, "admin/vendors/payout-account", "POST", createInput);
		expect(refused.status).toBe(409);

		const replaced = await call(ctx, "admin/vendors/payout-account", "POST", {
			...createInput,
			replace: true,
		});
		expect(replaced.status).toBe(201);
		expect((replaced.body.vendor as Vendor).paymentAccounts?.flw?.accountReference).toBe("RS_TEST");
	});

	it("rejects a provider without onboarding, bad countries and bad split values", async () => {
		registerPaymentProvider(onboardingProvider());
		registerPaymentProvider(createMockPaymentProvider({ id: "plain" }));
		const { ctx, getCol } = makeRouteContext({ "settings:flwSecretKey": "test-key" });
		getCol("vendors").set("v1", vendor());

		const noOnboarding = await call(ctx, "admin/vendors/payout-account", "POST", {
			...createInput,
			providerId: "plain",
		});
		expect(noOnboarding.status).toBe(400);

		const badCountry = await call(ctx, "admin/vendors/payout-account", "POST", {
			...createInput,
			country: "NGA",
		});
		expect(badCountry.status).toBe(400);

		const badPercentage = await call(ctx, "admin/vendors/payout-account", "POST", {
			...createInput,
			splitValue: 1.5,
		});
		expect(badPercentage.status).toBe(400);

		const badFlat = await call(ctx, "admin/vendors/payout-account", "POST", {
			...createInput,
			splitType: "flat",
			splitValue: 0,
		});
		expect(badFlat.status).toBe(400);
	});

	it("is gated like the other vendor routes", async () => {
		const { ctx } = makeRouteContext({});
		const res = await call(ctx, "admin/vendors/payout-banks", "GET");
		expect(res.status).toBe(409);
	});

	it("exposes payoutOnboarding to the Vendors page", async () => {
		registerPaymentProvider(onboardingProvider());
		const { ctx } = makeRouteContext({});
		const res = await call(ctx, "admin/settings", "GET");
		const providers = res.body._providers as Array<Record<string, unknown>>;
		const row = providers.find((provider) => provider.id === "flw");
		expect(row?.payoutOnboarding).toBe(true);
	});
});

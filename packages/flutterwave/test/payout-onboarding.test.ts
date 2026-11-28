import { describe, expect, it } from "bun:test";
import type { PaymentProviderRuntimeContext } from "@dashcommerce/core/payment-provider";
import { flutterwavePaymentProvider } from "../src/provider";

function makeCtx(
	handler: (url: string, init?: RequestInit) => Promise<Response>,
): PaymentProviderRuntimeContext {
	return {
		http: { fetch: handler },
		log: { info() {}, warn() {}, error() {} },
	};
}

function ok(data: unknown): Response {
	return new Response(JSON.stringify({ status: "success", message: "ok", data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Flutterwave payout onboarding", () => {
	const credentials = { secretKey: "FLWSECK_TEST-1234567890abcdef-X" };
	const baseInput = {
		accountNumber: "0690000031",
		bankCode: "044",
		country: "NG",
		businessName: "Vendor One",
		businessEmail: "v1@example.com",
		businessMobile: "09087930450",
	};

	it("lists the banks for a country, dropping malformed rows", async () => {
		let requested = "";
		const ctx = makeCtx(async (url) => {
			requested = url;
			return ok([
				{ code: "044", name: "Access Bank" },
				{ code: "", name: "No code" },
				{ code: "058", name: "" },
				{ code: "057", name: "Zenith Bank" },
			]);
		});
		const banks = await flutterwavePaymentProvider.listPayoutBanks?.(ctx, " ng ", credentials);
		expect(requested).toBe("https://api.flutterwave.com/v3/banks/NG");
		expect(banks).toEqual([
			{ code: "044", name: "Access Bank" },
			{ code: "057", name: "Zenith Bank" },
		]);
	});

	it("refuses a country that is not ISO-2", async () => {
		const ctx = makeCtx(async () => ok([]));
		await expect(
			flutterwavePaymentProvider.listPayoutBanks?.(ctx, "NGA", credentials),
		).rejects.toThrow(/ISO-2/);
	});

	it("resolves the account name with the documented body", async () => {
		let body: Record<string, unknown> = {};
		const ctx = makeCtx(async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return ok({ account_number: "0690000031", account_name: "Forrest Green" });
		});
		const result = await flutterwavePaymentProvider.resolvePayoutAccount?.(
			ctx,
			{ accountNumber: "0690000031", bankCode: "044" },
			credentials,
		);
		expect(body).toEqual({ account_number: "0690000031", account_bank: "044" });
		expect(result).toEqual({ accountName: "Forrest Green" });
	});

	it("creates a subaccount and returns the masked, stored metadata", async () => {
		let body: Record<string, unknown> = {};
		const ctx = makeCtx(async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return ok({
				id: 27708,
				account_number: "0690000031",
				account_bank: "044",
				full_name: "Forrest Green",
				subaccount_id: "RS_TEST",
				bank_name: "ACCESS BANK NIGERIA",
				split_type: "percentage",
				split_value: 0.1,
			});
		});

		const created = await flutterwavePaymentProvider.createPayoutAccount?.(
			ctx,
			{
				accountNumber: "0690000031",
				bankCode: "044",
				country: "ng",
				businessName: "Vendor One",
				businessEmail: "v1@example.com",
				businessMobile: "09087930450",
				businessContact: "Vendor Contact",
				splitType: "percentage",
				splitValue: 0.1,
				metadata: { marketplace: "m1" },
			},
			credentials,
		);

		expect(body.account_bank).toBe("044");
		expect(body.account_number).toBe("0690000031");
		expect(body.country).toBe("NG");
		expect(body.business_name).toBe("Vendor One");
		expect(body.business_email).toBe("v1@example.com");
		expect(body.business_mobile).toBe("09087930450");
		expect(body.business_contact).toBe("Vendor Contact");
		expect(body.split_type).toBe("percentage");
		expect(body.split_value).toBe(0.1);
		expect(body.meta).toEqual([{ meta_name: "marketplace", meta_value: "m1" }]);
		expect(created).toEqual({
			accountReference: "RS_TEST",
			accountName: "Forrest Green",
			verified: true,
			bankName: "ACCESS BANK NIGERIA",
			bankCode: "044",
			country: "NG",
			maskedAccountNumber: "••••0031",
			metadata: { providerAccountId: "27708" },
		});
	});

	it("returns the existing subaccount when Flutterwave says it already exists", async () => {
		let listCalls = 0;
		const ctx = makeCtx(async (url, init) => {
			const { pathname, searchParams } = new URL(url);
			if (pathname !== "/v3/subaccounts") {
				return new Response("{}", { status: 404 });
			}
			if (init?.method === "POST") {
				return new Response(
					JSON.stringify({
						status: "error",
						message: "A subaccount with the account number and bank already exists",
						data: null,
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			listCalls += 1;
			expect(searchParams.get("account_number")).toBe("0690000031");
			expect(searchParams.get("account_bank")).toBe("044");
			return ok([
				{
					id: 27708,
					account_number: "0690000031",
					account_bank: "044",
					full_name: "Forrest Green",
					subaccount_id: "RS_EXISTING",
					bank_name: "ACCESS BANK NIGERIA",
					country: "NG",
				},
			]);
		});

		const created = await flutterwavePaymentProvider.createPayoutAccount?.(
			ctx,
			baseInput,
			credentials,
		);
		expect(listCalls).toBe(1);
		expect(created?.accountReference).toBe("RS_EXISTING");
		expect(created?.verified).toBe(true);
	});

	it("rethrows a 400 when no existing subaccount matches", async () => {
		const ctx = makeCtx(async (url, init) => {
			const { pathname } = new URL(url);
			if (pathname === "/v3/subaccounts" && init?.method === "POST") {
				return new Response(
					JSON.stringify({ status: "error", message: "Invalid bank code", data: null }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			return ok([]);
		});

		await expect(
			flutterwavePaymentProvider.createPayoutAccount?.(ctx, baseInput, credentials),
		).rejects.toThrow(/Invalid bank code/);
	});

	it("does not hide a non-duplicate Flutterwave error", async () => {
		let listCalls = 0;
		const ctx = makeCtx(async (url, init) => {
			const { pathname } = new URL(url);
			if (pathname === "/v3/subaccounts" && init?.method === "POST") {
				return new Response(
					JSON.stringify({ status: "error", message: "Application error", data: null }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
			listCalls += 1;
			return ok([]);
		});

		await expect(
			flutterwavePaymentProvider.createPayoutAccount?.(ctx, baseInput, credentials),
		).rejects.toThrow(/Application error/);
		expect(listCalls).toBe(0);
	});

	it("validates the split and the required business fields", async () => {
		const ctx = makeCtx(async () => ok({}));
		const base = {
			accountNumber: "0690000031",
			bankCode: "044",
			country: "NG",
			businessName: "Vendor One",
			businessEmail: "v1@example.com",
			businessMobile: "09087930450",
		};
		await expect(
			flutterwavePaymentProvider.createPayoutAccount?.(
				ctx,
				{ ...base, splitType: "percentage", splitValue: 1.5 },
				credentials,
			),
		).rejects.toThrow(/decimal from 0 to 1/);
		await expect(
			flutterwavePaymentProvider.createPayoutAccount?.(
				ctx,
				{ ...base, splitType: "flat", splitValue: 0 },
				credentials,
			),
		).rejects.toThrow(/must be positive/);
		await expect(
			flutterwavePaymentProvider.createPayoutAccount?.(
				ctx,
				{ ...base, businessEmail: "" },
				credentials,
			),
		).rejects.toThrow(/business name, email and mobile/);
	});

	it("refuses a response without a subaccount id or account name", async () => {
		const ctx = makeCtx(async () => ok({ full_name: "Forrest Green" }));
		await expect(
			flutterwavePaymentProvider.createPayoutAccount?.(
				ctx,
				{
					accountNumber: "0690000031",
					bankCode: "044",
					country: "NG",
					businessName: "Vendor One",
					businessEmail: "v1@example.com",
					businessMobile: "09087930450",
				},
				credentials,
			),
		).rejects.toThrow(/no subaccount id/);
	});
});

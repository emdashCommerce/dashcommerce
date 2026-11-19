/**
 * "Test connection" in Settings for any registered provider that declares
 * checkConnection: one read-only call with the saved credentials, and an
 * answer the merchant can act on. Stripe keeps admin/stripe/ping.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	type ConnectionCheckResult,
	createMockPaymentProvider,
	type PaymentProvider,
	type PaymentProviderCredentials,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
import { makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

function acme(check?: PaymentProvider["checkConnection"]): PaymentProvider {
	return {
		...createMockPaymentProvider({ id: "acme" }),
		label: "Acme Pay",
		...(check ? { checkConnection: check } : {}),
	};
}

async function check(ctx: PluginContext, input: Record<string, unknown>) {
	const routeCtx = {
		request: new Request("http://test/admin/payments/check-connection", { method: "POST" }),
		input,
	} as unknown as RouteContext;
	const res = (await adminApiRoutes["admin/payments/check-connection"].handler(
		routeCtx,
		ctx,
	)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function providerRows(ctx: PluginContext) {
	const routeCtx = {
		request: new Request("http://test/admin/settings", { method: "GET" }),
	} as unknown as RouteContext;
	const res = (await adminApiRoutes["admin/settings"].handler(routeCtx, ctx)) as Response;
	const body = (await res.json()) as { _providers: Array<Record<string, unknown>> };
	return body._providers;
}

describe("provider connection check", () => {
	it("tells Settings which providers can be tested", async () => {
		registerPaymentProvider(acme(async () => ({ ok: true, message: "Connected." })));
		registerPaymentProvider({ ...createMockPaymentProvider({ id: "plain" }), label: "Plain" });
		const { ctx } = makeRouteContext({});
		const rows = await providerRows(ctx);
		expect(rows.find((r) => r.id === "acme")?.canCheckConnection).toBe(true);
		expect(rows.find((r) => r.id === "plain")?.canCheckConnection).toBe(false);
	});

	it("passes the saved credentials and returns the provider's answer", async () => {
		let seen: PaymentProviderCredentials | undefined;
		registerPaymentProvider(
			acme(async (_ctx, creds): Promise<ConnectionCheckResult> => {
				seen = creds;
				return { ok: true, message: "Connected in test mode.", mode: "test" };
			}),
		);
		const { ctx } = makeRouteContext({
			"settings:acmeSecretKey": "ak_test_1234567890",
			"settings:acmeWebhookSecret": "awh_1234567890",
		});
		const res = await check(ctx, { providerId: "acme" });
		expect(res).toEqual({
			status: 200,
			body: { ok: true, message: "Connected in test mode.", mode: "test" },
		});
		expect(seen).toEqual({ secretKey: "ak_test_1234567890", webhookSecret: "awh_1234567890" });
	});

	it("asks for the key when none is saved, without calling the provider", async () => {
		let called = false;
		registerPaymentProvider(
			acme(async () => {
				called = true;
				return { ok: true, message: "Connected." };
			}),
		);
		const { ctx } = makeRouteContext({});
		const res = await check(ctx, { providerId: "acme" });
		expect(res).toEqual({
			status: 200,
			body: { ok: false, message: "Save the Acme Pay secret key first." },
		});
		expect(called).toBe(false);
	});

	it("turns a thrown error into a plain message that never includes the key", async () => {
		registerPaymentProvider(
			acme(async (_ctx, creds) => {
				throw new Error(`socket hang up for ${creds.secretKey}`);
			}),
		);
		const { ctx, logs } = makeRouteContext({ "settings:acmeSecretKey": "ak_test_1234567890" });
		const res = await check(ctx, { providerId: "acme" });
		expect(res).toEqual({
			status: 200,
			body: { ok: false, message: "Couldn't reach Acme Pay. Try again in a moment." },
		});
		expect(JSON.stringify(res.body)).not.toContain("ak_test_1234567890");
		expect(logs.some((l) => l.level === "warn")).toBe(true);
		expect(JSON.stringify(logs)).not.toContain("ak_test_1234567890");
	});

	it("refuses providers without a check, and unknown ids", async () => {
		registerPaymentProvider(acme());
		const { ctx } = makeRouteContext({ "settings:acmeSecretKey": "ak_test_1234567890" });
		for (const providerId of ["acme", "nope", 42]) {
			const res = await check(ctx, { providerId });
			expect(res.status).toBe(400);
			expect(res.body).toEqual({
				error: { code: "NO_CONNECTION_CHECK", message: "This provider has no connection check." },
			});
		}
	});
});

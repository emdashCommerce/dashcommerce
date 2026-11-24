/**
 * Merchants save a non-Stripe provider's credentials through the settings
 * API, under the keys core already reads (`settings:<id>SecretKey`,
 * `settings:<id>WebhookSecret`), validated by prefixes the provider declares
 * and masked like Stripe's.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	type PaymentProvider,
	createMockPaymentProvider,
	loadPaymentProviderCredentials,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
import { makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

function acme(): PaymentProvider {
	return {
		...createMockPaymentProvider({ id: "acme" }),
		label: "Acme Pay",
		credentialFields: {
			secretKey: { label: "Secret or restricted key", prefixes: ["ak_test_", "ark_test_"] },
			webhookSecret: {
				label: "Webhook signing secret",
				prefixes: ["awh_"],
				help: "From the dashboard",
			},
			publicKey: {
				label: "Browser public key",
				prefixes: ["apk_test_", "apk_"],
				help: "Used by on-page checkout",
			},
		},
	};
}

async function call(ctx: PluginContext, method: "GET" | "POST", input?: Record<string, unknown>) {
	const routeCtx = {
		request: new Request("http://test/admin/settings", { method }),
		input,
	} as unknown as RouteContext;
	const res = (await adminApiRoutes["admin/settings"].handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("provider credentials in the settings API", () => {
	it("saves a registered provider's credentials where core reads them", async () => {
		registerPaymentProvider(acme());
		const { ctx } = makeRouteContext({});
		const res = await call(ctx, "POST", {
			paymentProvider: "acme",
			acmeSecretKey: "ark_test_1234567890",
			acmeWebhookSecret: "awh_1234567890",
			acmePublicKey: "apk_test_1234567890",
		});
		expect(res).toEqual({ status: 200, body: { ok: true } });
		expect(await loadPaymentProviderCredentials(ctx.kv, "acme")).toEqual({
			secretKey: "ark_test_1234567890",
			webhookSecret: "awh_1234567890",
			publicKey: "apk_test_1234567890",
		});
	});

	it("validates the public key against its declared prefixes", async () => {
		registerPaymentProvider(acme());
		const { ctx, kvStore } = makeRouteContext({});
		const res = await call(ctx, "POST", { acmePublicKey: "sk_live_wrong" });
		expect(res.status).toBe(400);
		expect(String((res.body.errors as Record<string, string>).acmePublicKey)).toContain("apk_");
		expect(kvStore.has("settings:acmePublicKey")).toBe(false);
	});

	it("refuses a public key for a provider that does not declare one", async () => {
		registerPaymentProvider(createMockPaymentProvider({ id: "plain" }));
		const { ctx } = makeRouteContext({});
		const res = await call(ctx, "POST", { plainPublicKey: "pk_123" });
		expect(res.status).toBe(400);
		expect(Object.keys(res.body.errors as object)).toEqual(["plainPublicKey"]);
	});

	it("refuses a value without a declared prefix", async () => {
		registerPaymentProvider(acme());
		const { ctx, kvStore } = makeRouteContext({});
		const res = await call(ctx, "POST", { acmeSecretKey: "sk_live_wrong" });
		expect(res.status).toBe(400);
		expect(String((res.body.errors as Record<string, string>).acmeSecretKey)).toContain("ak_test_");
		expect(kvStore.has("settings:acmeSecretKey")).toBe(false);
	});

	it("accepts any non-empty value when the provider declares no prefixes", async () => {
		registerPaymentProvider(createMockPaymentProvider({ id: "plain" }));
		const { ctx } = makeRouteContext({});
		expect((await call(ctx, "POST", { plainSecretKey: "anything" })).status).toBe(200);
		expect((await call(ctx, "POST", { plainSecretKey: "  " })).status).toBe(400);
	});

	it("refuses credentials for a provider that is not registered", async () => {
		const { ctx } = makeRouteContext({});
		const res = await call(ctx, "POST", { ghostSecretKey: "x_123" });
		expect(res.status).toBe(400);
		expect(Object.keys(res.body.errors as object)).toEqual(["ghostSecretKey"]);
	});

	it("keeps a saved secret when the form sends back its mask", async () => {
		registerPaymentProvider(acme());
		const { ctx, kvStore } = makeRouteContext({ "settings:acmeSecretKey": "ak_test_original" });
		const res = await call(ctx, "POST", { acmeSecretKey: "••••inal" });
		expect(res.status).toBe(200);
		expect(kvStore.get("settings:acmeSecretKey")).toBe("ak_test_original");
	});

	it("never returns a provider secret, only whether it is set and its last four", async () => {
		registerPaymentProvider(acme());
		const { ctx } = makeRouteContext({
			"settings:paymentProvider": "acme",
			"settings:acmeSecretKey": "ak_test_abcd1234",
			"settings:acmePublicKey": "apk_test_public5678",
		});
		const { body } = await call(ctx, "GET");
		expect(JSON.stringify(body)).not.toContain("ak_test_abcd1234");
		expect(JSON.stringify(body)).not.toContain("apk_test_public5678");
		const providers = body._providers as Array<Record<string, unknown>>;
		expect(providers.map((p) => p.id)).toEqual(["stripe", "acme"]);
		const acmeRow = providers.find((p) => p.id === "acme");
		expect(acmeRow).toEqual({
			id: "acme",
			label: "Acme Pay",
			description: null,
			logo: null,
			brandColour: null,
			credentialFields: {
				secretKey: { label: "Secret or restricted key", prefixes: ["ak_test_", "ark_test_"] },
				webhookSecret: {
					label: "Webhook signing secret",
					prefixes: ["awh_"],
					help: "From the dashboard",
				},
				publicKey: {
					label: "Browser public key",
					prefixes: ["apk_test_", "apk_"],
					help: "Used by on-page checkout",
				},
			},
			checkoutStyles: ["hosted"],
			capabilities: {},
			canCheckConnection: false,
			secrets: {
				secretKey: { isSet: true, hint: "••••1234" },
				webhookSecret: { isSet: false, hint: null },
				publicKey: { isSet: true, hint: "••••5678" },
			},
		});
	});

	it("omits the public key row for providers that do not declare one", async () => {
		registerPaymentProvider(createMockPaymentProvider({ id: "plain" }));
		const { ctx } = makeRouteContext({});
		const providers = (await call(ctx, "GET")).body._providers as Array<Record<string, unknown>>;
		expect(providers.find((p) => p.id === "plain")).toMatchObject({
			secrets: {
				secretKey: { isSet: false, hint: null },
				webhookSecret: { isSet: false, hint: null },
			},
		});
		const plain = providers.find((p) => p.id === "plain") as {
			secrets: Record<string, unknown>;
		};
		expect(plain.secrets.publicKey).toBeUndefined();
	});

	it("leaves Stripe's keys exactly as before", async () => {
		const { ctx } = makeRouteContext({});
		expect((await call(ctx, "POST", { stripeSecretKey: "rk_test_123" })).status).toBe(200);
		expect((await call(ctx, "POST", { stripeSecretKey: "whsec_123" })).status).toBe(400);
		const { body } = await call(ctx, "GET");
		expect((body._secrets as Record<string, unknown>).stripeSecretKey).toEqual({
			isSet: true,
			hint: "••••_123",
		});
	});
});

describe("provider cards in Settings", () => {
	it("returns each provider's description, logo and brand colour for the cards", async () => {
		registerPaymentProvider({
			...createMockPaymentProvider({ id: "brandy" }),
			label: "Brandy",
			description: "Card and M-Pesa",
			logo: "https://cdn.example/brandy.svg",
			brandColour: "#123456",
		});
		const { ctx } = makeRouteContext({});
		const providers = (await call(ctx, "GET")).body._providers as Array<Record<string, unknown>>;
		expect(providers.find((p) => p.id === "brandy")).toMatchObject({
			description: "Card and M-Pesa",
			logo: "https://cdn.example/brandy.svg",
			brandColour: "#123456",
		});
		expect(providers.find((p) => p.id === "stripe")).toMatchObject({
			label: "Stripe",
			brandColour: "#635BFF",
		});
	});

	it("drops a logo that isn't https or an image data URI, and a malformed colour", async () => {
		registerPaymentProvider({
			...createMockPaymentProvider({ id: "sneaky" }),
			logo: "javascript:alert(1)",
			brandColour: "red; background:url(x)",
		});
		const { ctx } = makeRouteContext({});
		const providers = (await call(ctx, "GET")).body._providers as Array<Record<string, unknown>>;
		expect(providers.find((p) => p.id === "sneaky")).toMatchObject({
			logo: null,
			brandColour: null,
		});
	});
});

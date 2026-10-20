import { describe, expect, test } from "bun:test";
import {
	buildReturnUrl,
	isStripeSecretKey,
	isStripeWebhookSecret,
	isValidReturnUrl,
	normalizeCurrency,
	parseCountries,
} from "../../src/settings";

describe("settings helpers", () => {
	test("buildReturnUrl joins site paths and keeps Stripe template tokens", () => {
		expect(
			buildReturnUrl("/thanks?o={ORDER_ID}&s={CHECKOUT_SESSION_ID}", "https://shop.example/", {
				ORDER_ID: "abc",
			}),
		).toBe("https://shop.example/thanks?o=abc&s={CHECKOUT_SESSION_ID}");
		expect(buildReturnUrl("https://other.example/x", "https://shop.example", {})).toBe(
			"https://other.example/x",
		);
	});

	test("return URL validation rejects protocol-relative and non-https URLs", () => {
		expect(isValidReturnUrl("/cart")).toBe(true);
		expect(isValidReturnUrl("https://shop.example/ok")).toBe(true);
		expect(isValidReturnUrl("//evil.example")).toBe(false);
		expect(isValidReturnUrl("http://shop.example")).toBe(false);
		expect(isValidReturnUrl("javascript:alert(1)")).toBe(false);
	});

	test("currency and countries", () => {
		expect(normalizeCurrency(" usd ")).toBe("USD");
		expect(normalizeCurrency("US")).toBeUndefined();
		expect(parseCountries("us, ca ,GB,us")).toEqual(["US", "CA", "GB"]);
		expect(parseCountries("")).toEqual([]);
		expect(parseCountries("USA")).toBeUndefined();
	});

	test("Stripe key shapes", () => {
		expect(isStripeSecretKey("sk_test_abcdefgh123")).toBe(true);
		expect(isStripeSecretKey("rk_live_abcdefgh123")).toBe(true);
		expect(isStripeSecretKey("pk_test_abcdefgh123")).toBe(false);
		expect(isStripeWebhookSecret("whsec_abcdefgh123")).toBe(true);
		expect(isStripeWebhookSecret("sk_test_abcdefgh")).toBe(false);
	});
});

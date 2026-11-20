import { describe, expect, it } from "bun:test";
import { dashcommerce } from "../src/index";

const STRIPE_HOSTS = ["api.stripe.com", "files.stripe.com"];

function hostsOf(options?: Parameters<typeof dashcommerce>[0]) {
	const descriptor = dashcommerce({ emdashVersion: "1.5.0", ...options }) as unknown as {
		allowedHosts: string[];
		options: { allowedHosts: string[] };
	};
	return { descriptor: descriptor.allowedHosts, runtime: descriptor.options.allowedHosts };
}

describe("dashcommerce({ allowedHosts })", () => {
	it("keeps exactly Stripe's hosts when the option is not set", () => {
		expect(hostsOf()).toEqual({ descriptor: STRIPE_HOSTS, runtime: STRIPE_HOSTS });
	});

	it("adds the extra hosts after Stripe's, in the descriptor and the runtime options", () => {
		const expected = [...STRIPE_HOSTS, "api.paystack.co"];
		expect(hostsOf({ allowedHosts: ["api.paystack.co"] })).toEqual({
			descriptor: expected,
			runtime: expected,
		});
	});

	it("normalises case and drops duplicates", () => {
		const { runtime } = hostsOf({
			allowedHosts: ["API.Paystack.co", "api.paystack.co", "api.stripe.com"],
		});
		expect(runtime).toEqual([...STRIPE_HOSTS, "api.paystack.co"]);
	});

	it("accepts a subdomain wildcard, which EmDash supports", () => {
		expect(hostsOf({ allowedHosts: ["*.pesapal.com"] }).runtime).toContain("*.pesapal.com");
	});

	it("refuses anything that is not a host name, loudly", () => {
		for (const bad of [
			"*",
			"https://api.paystack.co",
			"api.paystack.co/transaction",
			"api.paystack.co:443",
			"",
			" ",
			"api paystack.co",
			"*.*.example.com",
		]) {
			expect(() => dashcommerce({ emdashVersion: "1.5.0", allowedHosts: [bad] })).toThrow(
				/allowedHosts/,
			);
		}
	});
});

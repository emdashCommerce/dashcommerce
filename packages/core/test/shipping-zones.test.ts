import { describe, expect, it } from "bun:test";
import { matchesZone, pickZone } from "../src/shipping/calculate";
import type { Address, ShippingZone } from "../src/types";

function zone(
	id: string,
	locations: Array<{ country: string; regions?: string[] }>,
	order = 0,
): ShippingZone {
	return {
		id,
		name: `Zone ${id}`,
		locations,
		order,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function address(country: string, region = "", postalCode = "12345"): Address {
	return {
		firstName: "Test",
		lastName: "User",
		line1: "123 Main St",
		city: "City",
		region,
		postalCode,
		country,
	};
}

describe("shipping zone matching", () => {
	it("matches zone with country-only location (no regions)", () => {
		const z = zone("us", [{ country: "US" }]);
		expect(matchesZone(address("US", "NY"), z)).toBe(true);
		expect(matchesZone(address("US", "CA"), z)).toBe(true);
		expect(matchesZone(address("CA", "ON"), z)).toBe(false);
	});

	it("matches zone with specific regions", () => {
		const z = zone("us-east", [{ country: "US", regions: ["NY", "NJ", "CT"] }]);
		expect(matchesZone(address("US", "NY"), z)).toBe(true);
		expect(matchesZone(address("US", "NJ"), z)).toBe(true);
		expect(matchesZone(address("US", "CA"), z)).toBe(false);
	});

	it("does not match zone with empty locations array", () => {
		const z = zone("empty", []);
		expect(matchesZone(address("US", "NY"), z)).toBe(false);
		expect(matchesZone(address("CA", "ON"), z)).toBe(false);
	});

	it("matches zone with multiple location entries", () => {
		const z = zone("us-ca", [
			{ country: "US", regions: ["CA"] },
			{ country: "CA", regions: ["BC", "ON"] },
		]);
		expect(matchesZone(address("US", "CA"), z)).toBe(true);
		expect(matchesZone(address("CA", "BC"), z)).toBe(true);
		expect(matchesZone(address("US", "NY"), z)).toBe(false);
	});

	it("picks first matching zone by order", () => {
		const zones = [
			zone("all", [{ country: "US" }], 10),
			zone("west", [{ country: "US", regions: ["CA", "OR"] }], 0),
		];
		const caAddr = address("US", "CA");
		const nyAddr = address("US", "NY");
		// CA should match the west zone (order 0) first
		expect(pickZone(caAddr, zones)?.id).toBe("west");
		// NY should match the all zone (order 10) since west doesn't match
		expect(pickZone(nyAddr, zones)?.id).toBe("all");
	});

	it("returns null when no zone matches", () => {
		const zones = [zone("canada", [{ country: "CA" }])];
		expect(pickZone(address("US", "NY"), zones)).toBeNull();
	});

	it("matches common US zip codes to US-wide zone", () => {
		const usZone = zone("us", [{ country: "US" }]);
		// Test case from P1: NY 10001
		expect(matchesZone(address("US", "NY", "10001"), usZone)).toBe(true);
		// Test case from P1: CA 90210
		expect(matchesZone(address("US", "CA", "90210"), usZone)).toBe(true);
	});
});

import { describe, expect, it } from "bun:test";
import { normalizeShippingShape } from "../src/admin/shipping-shape";

describe("normalizeShippingShape", () => {
	it("keeps well-formed lists", () => {
		const zone = {
			id: "z1",
			name: "US",
			locations: [],
			order: 0,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};
		const out = normalizeShippingShape({
			zones: [zone],
			methods: [],
			classes: [],
		});
		expect(out.zones).toEqual([zone]);
		expect(out.methods).toEqual([]);
		expect(out.classes).toEqual([]);
	});

	it("falls back when methods is missing (flattened EmDash envelope)", () => {
		const out = normalizeShippingShape({});
		expect(out.zones).toEqual([]);
		expect(out.methods).toEqual([]);
		expect(out.classes).toEqual([]);
	});

	it("falls back for null, undefined, and non-objects", () => {
		expect(normalizeShippingShape(undefined).methods).toEqual([]);
		expect(normalizeShippingShape(null).methods).toEqual([]);
		expect(normalizeShippingShape("nope").zones).toEqual([]);
	});

	it("ignores non-array methods/zones/classes", () => {
		const out = normalizeShippingShape({
			zones: { id: "z" },
			methods: undefined,
			classes: "x",
		});
		expect(out.zones).toEqual([]);
		expect(out.methods).toEqual([]);
		expect(out.classes).toEqual([]);
	});
});

import { describe, expect, it } from "bun:test";
import {
	add,
	compare,
	CurrencyMismatchError,
	format,
	gte,
	isNegative,
	isZero,
	lte,
	minorUnitsFactor,
	money,
	mul,
	parse,
	percent,
	sub,
	sum,
	zero,
} from "../src/money";

describe("Money", () => {
	it("rejects non-integer amounts at construction", () => {
		expect(() => money("USD", 1.5)).toThrow(/integer/);
	});

	it("normalizes currency codes to uppercase", () => {
		expect(money("usd", 100).currency).toBe("USD");
	});

	it("returns 1/100/1000 factor for zero/two/three-decimal currencies", () => {
		expect(minorUnitsFactor("JPY")).toBe(1);
		expect(minorUnitsFactor("USD")).toBe(100);
		expect(minorUnitsFactor("BHD")).toBe(1000);
		expect(minorUnitsFactor("eur")).toBe(100);
	});

	it("adds same-currency values and throws on mismatch", () => {
		expect(add(money("USD", 100), money("USD", 250))).toEqual(money("USD", 350));
		expect(() => add(money("USD", 100), money("EUR", 100))).toThrow(
			CurrencyMismatchError,
		);
	});

	it("subtracts same-currency values", () => {
		expect(sub(money("USD", 500), money("USD", 300))).toEqual(money("USD", 200));
	});

	it("multiplies by a scalar with half-up rounding", () => {
		expect(mul(money("USD", 199), 3)).toEqual(money("USD", 597));
		expect(mul(money("USD", 333), 0.5)).toEqual(money("USD", 167)); // .5 rounds up
	});

	it("computes percentages with half-up rounding", () => {
		expect(percent(money("USD", 10_000), 10)).toEqual(money("USD", 1_000));
		expect(percent(money("USD", 333), 10)).toEqual(money("USD", 33));
	});

	it("sums values with fallback currency for empty lists", () => {
		expect(sum([money("USD", 100), money("USD", 250)])).toEqual(money("USD", 350));
		expect(sum([], "USD")).toEqual(zero("USD"));
		expect(() => sum([])).toThrow(/fallback/);
	});

	it("compare / gte / lte / isZero / isNegative", () => {
		expect(compare(money("USD", 100), money("USD", 100))).toBe(0);
		expect(gte(money("USD", 100), money("USD", 50))).toBe(true);
		expect(lte(money("USD", 50), money("USD", 100))).toBe(true);
		expect(isZero(money("USD", 0))).toBe(true);
		expect(isNegative(money("USD", -1))).toBe(true);
	});

	it("formats + parses with correct minor-unit factor", () => {
		expect(format(money("USD", 1299))).toContain("12.99");
		expect(format(money("JPY", 500))).toContain("500");
		expect(parse("$19.99", "USD")).toEqual(money("USD", 1999));
		expect(parse("¥500", "JPY")).toEqual(money("JPY", 500));
	});
});

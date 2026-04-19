import { describe, expect, it } from "bun:test";
import {
	canTransition,
	derivePaymentStatus,
	deriveOrderStatusFromRefunds,
	InvalidOrderTransitionError,
	isTerminal,
	assertTransition,
} from "../src/orders/status";

describe("canTransition", () => {
	it("allows a freshly-paid order to move pending → processing", () => {
		expect(canTransition("pending", "processing")).toBe(true);
	});

	it("allows processing → completed", () => {
		expect(canTransition("processing", "completed")).toBe(true);
	});

	it("allows completed → partially-refunded", () => {
		expect(canTransition("completed", "partially-refunded")).toBe(true);
	});

	it("rejects cancelled → processing", () => {
		expect(canTransition("cancelled", "processing")).toBe(false);
	});

	it("rejects refunded → anything (terminal)", () => {
		expect(canTransition("refunded", "processing")).toBe(false);
		expect(canTransition("refunded", "completed")).toBe(false);
	});

	it("self-transition is always allowed", () => {
		expect(canTransition("completed", "completed")).toBe(true);
	});
});

describe("assertTransition", () => {
	it("throws on illegal transitions", () => {
		expect(() => assertTransition("cancelled", "processing")).toThrow(
			InvalidOrderTransitionError,
		);
	});

	it("returns void on legal transitions", () => {
		expect(() => assertTransition("processing", "completed")).not.toThrow();
	});
});

describe("isTerminal", () => {
	it("recognizes the four terminal states", () => {
		expect(isTerminal("completed")).toBe(true);
		expect(isTerminal("cancelled")).toBe(true);
		expect(isTerminal("refunded")).toBe(true);
		expect(isTerminal("failed")).toBe(true);
		expect(isTerminal("processing")).toBe(false);
	});
});

describe("derivePaymentStatus", () => {
	it("returns pending when no payment captured", () => {
		expect(derivePaymentStatus(0, 0)).toBe("pending");
	});

	it("returns paid when no refunds applied", () => {
		expect(derivePaymentStatus(10_000, 0)).toBe("paid");
	});

	it("returns partially-refunded when refund < paid", () => {
		expect(derivePaymentStatus(10_000, 4_000)).toBe("partially-refunded");
	});

	it("returns refunded when refund meets or exceeds paid", () => {
		expect(derivePaymentStatus(10_000, 10_000)).toBe("refunded");
		expect(derivePaymentStatus(10_000, 12_000)).toBe("refunded");
	});
});

describe("deriveOrderStatusFromRefunds", () => {
	it("leaves status alone when no refund applied", () => {
		expect(deriveOrderStatusFromRefunds("processing", 10_000, 0)).toBe("processing");
	});

	it("moves partial refund to partially-refunded", () => {
		expect(deriveOrderStatusFromRefunds("completed", 10_000, 4_000)).toBe(
			"partially-refunded",
		);
	});

	it("full refund lands on refunded regardless of prior status", () => {
		expect(deriveOrderStatusFromRefunds("completed", 10_000, 10_000)).toBe(
			"refunded",
		);
		expect(deriveOrderStatusFromRefunds("processing", 10_000, 10_000)).toBe(
			"refunded",
		);
	});
});

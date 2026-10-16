import { describe, expect, test } from "bun:test";
import {
	EMDASH_VERSIONS_WITH_SHIPPED_PATCHES,
	SUPPORTED_EMDASH_PEER,
	checkEmDashVersion,
	emDashPatchMismatchMessage,
	isEmDashVersionSupported,
	matchingShippedEmDashPatch,
	validateEmDashCompatibility,
} from "../src/version-check";

describe("EmDash version compatibility", () => {
	test("peer string matches the dual range we advertise", () => {
		expect(SUPPORTED_EMDASH_PEER).toBe(">=0.37.0 <0.38.0 || >=1.1.0 <1.4.0");
	});

	test.each(["0.37.0", "0.37.9", "1.1.0", "1.1.9", "1.2.0", "1.3.0", "1.3.9"])("accepts supported %s", (version) => {
		expect(isEmDashVersionSupported(version)).toBe(true);
		expect(() => checkEmDashVersion(version)).not.toThrow();
	});

	test.each(["0.36.9", "0.38.0", "0.42.0", "1.0.0", "1.0.1", "1.4.0", "1.9.0", "2.0.0"])(
		"rejects unsupported %s",
		(version) => {
			expect(isEmDashVersionSupported(version)).toBe(false);
			expect(() => checkEmDashVersion(version)).toThrow(/incompatibility/);
		},
	);

	test("below-floor error still points at 0.1.5 as the 0.28-era pin", () => {
		expect(() => checkEmDashVersion("0.28.1")).toThrow(/@dashcommerce\/core@\^0\.1\.5/);
	});

	test("gap / too-new error lists both supported windows", () => {
		expect(() => checkEmDashVersion("0.38.0")).toThrow(SUPPORTED_EMDASH_PEER);
		expect(() => checkEmDashVersion("1.0.0")).toThrow(/not 1\.0\.0/);
	});

	test("shipped patches are version-exact including 1.3.0", () => {
		expect(EMDASH_VERSIONS_WITH_SHIPPED_PATCHES).toEqual(["0.37.0", "1.1.0", "1.2.0", "1.3.0"]);
		expect(matchingShippedEmDashPatch("1.3.0")).toBe("1.3.0");
		expect(matchingShippedEmDashPatch("1.3.1")).toBeNull();
		expect(emDashPatchMismatchMessage("1.3.0")).toBeNull();
		expect(emDashPatchMismatchMessage("1.3.1")).toMatch(/hashed dist/);
		expect(matchingShippedEmDashPatch("1.2.0")).toBe("1.2.0");
		expect(matchingShippedEmDashPatch("1.2.1")).toBeNull();
		expect(matchingShippedEmDashPatch("1.1.5")).toBeNull();
		expect(emDashPatchMismatchMessage("1.2.0")).toBeNull();
		expect(emDashPatchMismatchMessage("1.2.1")).toMatch(/hashed dist/);
		expect(emDashPatchMismatchMessage("0.38.0")).toBeNull();
	});

	test("validateEmDashCompatibility warns when 1.3.x is not exactly 1.3.0", () => {
		const warnings: string[] = [];
		const orig = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			validateEmDashCompatibility("1.3.1");
		} finally {
			console.warn = orig;
		}
		expect(warnings.join("\n")).toMatch(/1\.3\.0 patch will not apply to 1\.3\.1\+/);
	});
});

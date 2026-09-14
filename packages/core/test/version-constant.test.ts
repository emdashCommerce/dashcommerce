/**
 * Test that DASHCOMMERCE_VERSION constant matches package.json version.
 * This ensures the constant doesn't drift when Changesets bumps the version.
 */

import { describe, expect, test } from "bun:test";
import { DASHCOMMERCE_VERSION } from "../src/index";
import pkg from "../package.json";

describe("Version constant hygiene", () => {
	test("DASHCOMMERCE_VERSION matches package.json version", () => {
		expect(DASHCOMMERCE_VERSION).toBe(pkg.version);
	});
});

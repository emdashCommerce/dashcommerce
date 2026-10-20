/**
 * packages/starter ships copies of the storefront kit for its sandboxed
 * edition (DASHCOMMERCE_EDITION=sandboxed). The starter is mirrored to
 * emdashCommerce/starter as a flat repo, so it cannot import from this
 * package. This test keeps the copies identical; fix drift with
 * `bun run --cwd packages/lite kit:sync`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LITE = join(import.meta.dir, "../..");
const STARTER = join(LITE, "../starter/src");

const PAIRS: Array<[string, string]> = [
	["storefront/dashcommerce.js", "lib/dashcommerce.js"],
	["storefront/dashcommerce.d.ts", "lib/dashcommerce.d.ts"],
	["storefront/astro/AddToCart.astro", "components/AddToCart.astro"],
	["storefront/astro/CartCount.astro", "components/CartCount.astro"],
	["storefront/astro/Cart.astro", "components/Cart.astro"],
	["storefront/astro/CheckoutSuccess.astro", "components/CheckoutSuccess.astro"],
];

describe("starter kit copies", () => {
	for (const [src, copy] of PAIRS) {
		test(copy, () => {
			expect(readFileSync(join(STARTER, copy), "utf8")).toBe(readFileSync(join(LITE, src), "utf8"));
		});
	}
});

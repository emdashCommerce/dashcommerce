import { describe, expect, test } from "bun:test";

import { mergeDashCommerceSeed } from "../src/seed/merge-dashcommerce-seed";

describe("mergeDashCommerceSeed", () => {
	test("inserts products collection and taxonomies into empty seed", () => {
		const out = mergeDashCommerceSeed({});
		expect(out.version).toBe("1");
		expect(Array.isArray(out.collections)).toBe(true);
		const slugs = (out.collections as { slug: string }[]).map((c) => c.slug);
		expect(slugs).toContain("products");
		const names = (out.taxonomies as { name: string }[]).map((t) => t.name);
		expect(names).toContain("product_category");
		expect(names).toContain("product_tag");
	});

	test("replaces existing products collection by slug", () => {
		const out = mergeDashCommerceSeed({
			version: "1",
			collections: [
				{
					slug: "products",
					label: "Old",
					fields: [],
				},
			],
			taxonomies: [],
		});
		const products = (out.collections as { slug: string; label: string }[]).filter((c) => c.slug === "products");
		expect(products.length).toBe(1);
		expect(products[0].label).toBe("Products");
	});

	test("dedupes taxonomies by name and keeps unrelated taxonomies", () => {
		const out = mergeDashCommerceSeed({
			version: "1",
			collections: [],
			taxonomies: [
				{
					name: "product_category",
					label: "Stale",
					hierarchical: true,
					collections: ["products"],
				},
				{
					name: "blog_category",
					label: "Blog",
					hierarchical: true,
					collections: ["posts"],
				},
			],
		});
		const names = (out.taxonomies as { name: string; label: string }[]).map((t) => t.name);
		const blog = (out.taxonomies as { name: string; label: string }[]).find((t) => t.name === "blog_category");
		const pc = (out.taxonomies as { name: string; label: string }[]).filter((t) => t.name === "product_category");
		expect(blog?.label).toBe("Blog");
		expect(pc.length).toBe(1);
		expect(pc[0].label).toBe("Product Categories");
	});
});

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

	test("withDemoCatalog appends six demo products + populates taxonomy terms", () => {
		const out = mergeDashCommerceSeed({}, { withDemoCatalog: true });
		const content = out.content as { products: Array<{ id: string }> };
		expect(Array.isArray(content.products)).toBe(true);
		expect(content.products.length).toBe(6);
		const skus = content.products.map((p) => p.id).sort();
		expect(skus).toEqual(
			[
				"design-templates",
				"enamel-mug",
				"graphic-tee",
				"monthly-box",
				"partner-good",
				"starter-bundle",
			].sort(),
		);
		const taxonomies = out.taxonomies as Array<{
			name: string;
			terms?: Array<{ slug: string }>;
		}>;
		const cat = taxonomies.find((t) => t.name === "product_category");
		const tag = taxonomies.find((t) => t.name === "product_tag");
		expect(cat?.terms?.length).toBe(4);
		expect(tag?.terms?.length).toBe(6);
	});

	test("withDemoCatalog preserves existing products with matching ids", () => {
		const out = mergeDashCommerceSeed(
			{
				content: {
					products: [
						{ id: "enamel-mug", slug: "enamel-mug", status: "published", data: { title: "Custom Mug" } },
					],
				},
			},
			{ withDemoCatalog: true },
		);
		const content = out.content as { products: Array<{ id: string; data: { title: string } }> };
		const mugs = content.products.filter((p) => p.id === "enamel-mug");
		expect(mugs.length).toBe(1);
		expect(mugs[0].data.title).toBe("Custom Mug");
		expect(content.products.length).toBe(6);
	});

	test("withDemoCatalog omitted leaves content untouched", () => {
		const out = mergeDashCommerceSeed({ content: { products: [] } });
		const content = out.content as { products: unknown[] } | undefined;
		expect(content?.products).toEqual([]);
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

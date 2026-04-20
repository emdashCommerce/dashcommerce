/**
 * Merge DashCommerce collection + taxonomy definitions into an EmDash seed object.
 * Used by the `dashcommerce-merge-seed` CLI and available for programmatic use.
 */

import {
	DEMO_PRODUCTS,
	DEMO_PRODUCT_CATEGORY_TERMS,
	DEMO_PRODUCT_TAG_TERMS,
	type DemoProductEntry,
} from "./demo-catalog";
import { defineProductTaxonomies, defineProductsCollection } from "./products-collection";
import type { DefineProductsCollectionOptions } from "./products-collection";

export interface MergeDashCommerceSeedOptions extends DefineProductsCollectionOptions {
	/**
	 * Append six demo products spanning every DashCommerce product type
	 * (simple, variable, grouped, external, subscription, digital) plus
	 * curated `product_category` / `product_tag` terms. Useful for first-run
	 * smoke tests so the admin isn't empty.
	 *
	 * Merging is additive and keyed by product `id`: existing entries with
	 * matching ids are preserved so operator-authored products are never
	 * overwritten.
	 *
	 * @default false
	 */
	withDemoCatalog?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge `defineProductsCollection` / `defineProductTaxonomies` into a seed-like object.
 * - **Collections:** replaces an existing entry with the same `slug` as the merged collection, otherwise appends.
 * - **Taxonomies:** removes any existing entries whose `name` matches a DashCommerce product taxonomy, then appends the canonical definitions.
 * - **Demo catalog** (`withDemoCatalog: true`): populates the product taxonomies with curated terms and appends six demo products under `content.products`, keyed by `id` so existing entries are preserved.
 */
export function mergeDashCommerceSeed(
	seed: Record<string, unknown>,
	options: MergeDashCommerceSeedOptions = {},
): Record<string, unknown> {
	const { withDemoCatalog, ...collectionOptions } = options;

	const collection = defineProductsCollection(collectionOptions) as Record<string, unknown>;
	const slug = typeof collection.slug === "string" ? collection.slug : "products";

	const baseTaxonomies = defineProductTaxonomies() as Array<Record<string, unknown>>;
	const incomingTaxonomies: Array<Record<string, unknown>> = withDemoCatalog
		? baseTaxonomies.map((tax) => {
				if (tax.name === "product_category") {
					return { ...tax, terms: DEMO_PRODUCT_CATEGORY_TERMS };
				}
				if (tax.name === "product_tag") {
					return { ...tax, terms: DEMO_PRODUCT_TAG_TERMS };
				}
				return tax;
			})
		: baseTaxonomies;
	const incomingTaxonomyNames = new Set(
		incomingTaxonomies.map((t) => (typeof t.name === "string" ? t.name : "")).filter(Boolean),
	);

	const collectionsRaw = seed.collections;
	const collections: Record<string, unknown>[] = Array.isArray(collectionsRaw)
		? collectionsRaw.filter(isRecord)
		: [];

	const idx = collections.findIndex((c) => typeof c.slug === "string" && c.slug === slug);
	if (idx >= 0) {
		collections[idx] = collection;
	} else {
		collections.push(collection);
	}

	const taxonomiesRaw = seed.taxonomies;
	const existingTaxonomies: Record<string, unknown>[] = Array.isArray(taxonomiesRaw)
		? taxonomiesRaw.filter(isRecord)
		: [];

	const kept = existingTaxonomies.filter((t) => {
		const name = typeof t.name === "string" ? t.name : "";
		return name === "" || !incomingTaxonomyNames.has(name);
	});

	const merged: Record<string, unknown> = {
		...seed,
		version: seed.version ?? "1",
		collections,
		taxonomies: [...kept, ...incomingTaxonomies],
	};

	if (withDemoCatalog) {
		const contentRaw = isRecord(seed.content) ? seed.content : {};
		const productsRaw = contentRaw[slug];
		const existingProducts: DemoProductEntry[] = Array.isArray(productsRaw)
			? productsRaw.filter(isRecord).map((p) => p as unknown as DemoProductEntry)
			: [];
		const existingIds = new Set(existingProducts.map((p) => p.id).filter(Boolean));
		const appended = DEMO_PRODUCTS.filter((p) => !existingIds.has(p.id));
		merged.content = {
			...contentRaw,
			[slug]: [...existingProducts, ...appended],
		};
	}

	return merged;
}

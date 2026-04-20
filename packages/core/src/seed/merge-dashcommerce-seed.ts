/**
 * Merge DashCommerce collection + taxonomy definitions into an EmDash seed object.
 * Used by the `dashcommerce-merge-seed` CLI and available for programmatic use.
 */

import { defineProductTaxonomies, defineProductsCollection } from "./products-collection";
import type { DefineProductsCollectionOptions } from "./products-collection";

export type MergeDashCommerceSeedOptions = DefineProductsCollectionOptions;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge `defineProductsCollection` / `defineProductTaxonomies` into a seed-like object.
 * - **Collections:** replaces an existing entry with the same `slug` as the merged collection, otherwise appends.
 * - **Taxonomies:** removes any existing entries whose `name` matches a DashCommerce product taxonomy, then appends the canonical definitions.
 */
export function mergeDashCommerceSeed(
	seed: Record<string, unknown>,
	options: MergeDashCommerceSeedOptions = {},
): Record<string, unknown> {
	const collection = defineProductsCollection(options) as Record<string, unknown>;
	const slug = typeof collection.slug === "string" ? collection.slug : "products";

	const incomingTaxonomies = defineProductTaxonomies() as Array<Record<string, unknown>>;
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

	return {
		...seed,
		version: seed.version ?? "1",
		collections,
		taxonomies: [...kept, ...incomingTaxonomies],
	};
}

/**
 * Product variant CRUD against `ctx.storage.product_variants`.
 *
 * Variants are plugin-storage rather than content-collection rows so they
 * can be queried by productId + sku uniqueness without bloating the
 * emdash content editor.
 */

import type { PluginContext, StorageCollection } from "emdash";
import type { ProductVariant } from "../types";

type VariantStorage = StorageCollection<ProductVariant>;

function variantsStore(ctx: PluginContext): VariantStorage {
	return (ctx.storage as unknown as { product_variants: VariantStorage }).product_variants;
}

export async function getVariant(
	ctx: PluginContext,
	variantId: string,
): Promise<ProductVariant | null> {
	const record = await variantsStore(ctx).get(variantId);
	if (!record) return null;
	// storage.get returns the raw row; keep id present for callers.
	return { ...(record as ProductVariant), id: variantId };
}

export async function listVariantsForProduct(
	ctx: PluginContext,
	productId: string,
	options: { activeOnly?: boolean; limit?: number; cursor?: string } = {},
): Promise<{ items: ProductVariant[]; cursor?: string; hasMore: boolean }> {
	const where: Record<string, string | boolean> = { productId };
	if (options.activeOnly) where.isActive = true;
	const result = await variantsStore(ctx).query({
		where,
		limit: options.limit ?? 100,
		cursor: options.cursor,
	});
	return {
		items: result.items.map((row) => ({ ...(row.data as ProductVariant), id: row.id })),
		cursor: result.cursor,
		hasMore: result.hasMore,
	};
}

export async function findVariantBySku(
	ctx: PluginContext,
	sku: string,
): Promise<ProductVariant | null> {
	const result = await variantsStore(ctx).query({ where: { sku }, limit: 1 });
	const first = result.items[0];
	if (!first) return null;
	return { ...(first.data as ProductVariant), id: first.id };
}

export async function putVariant(
	ctx: PluginContext,
	variant: ProductVariant,
): Promise<ProductVariant> {
	const now = new Date().toISOString();
	const toStore: ProductVariant = {
		...variant,
		updatedAt: now,
		createdAt: variant.createdAt ?? now,
	};
	await variantsStore(ctx).put(variant.id, toStore);
	return toStore;
}

export async function deleteVariant(ctx: PluginContext, variantId: string): Promise<boolean> {
	return variantsStore(ctx).delete(variantId);
}

/**
 * Decrement a variant's stock by `delta`. Returns the new stock level, or
 * `null` if the variant is not tracking stock (`stockQuantity === null`).
 * Idempotency must be handled by the caller (e.g. ledger write + unique
 * index on orderId+variantId combination).
 */
export async function adjustVariantStock(
	ctx: PluginContext,
	variantId: string,
	delta: number,
): Promise<number | null> {
	const variant = await getVariant(ctx, variantId);
	if (!variant) throw new Error(`Variant ${variantId} not found`);
	if (variant.stockQuantity === null) return null;
	const next = variant.stockQuantity + delta;
	await putVariant(ctx, { ...variant, stockQuantity: next });
	return next;
}

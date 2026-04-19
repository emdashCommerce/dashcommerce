/**
 * Stock restoration on refund / order cancel.
 *
 * Symmetric to `inventory/decrement.ts` — writes a positive delta ledger
 * entry with reason `refund` (or `order_cancelled`, `restock`). When
 * restoration lifts stock back above `lowStockThreshold`, `belowThresholdAt`
 * is cleared so the low-stock alert can re-fire if we dip below again.
 */

import type { ContentAccess, PluginContext } from "emdash";
import { adjustVariantStock } from "../products/variants";
import { normalizeProductFields } from "../products/normalize";

/** Local alias: emdash's ContentAccessWithWrite is not re-exported. */
type ContentWriteOp = NonNullable<ContentAccess["update"]>;
import type { InventoryLedgerReason, OrderItem, ProductFields } from "../types";
import { putLedgerEntry } from "./ledger";

export interface RestoreInput {
	orderItem: OrderItem;
	quantity: number; // how many units to restore (≤ orderItem.quantity)
	reason: Extract<InventoryLedgerReason, "refund" | "order_cancelled" | "restock">;
	refundId?: string;
	note?: string;
}

export interface RestoreResult {
	newStock: number | null;
}

async function loadProductData(
	ctx: PluginContext,
	productId: string,
): Promise<ProductFields | null> {
	if (!ctx.content) return null;
	const record = await ctx.content.get("products", productId);
	if (!record) return null;
	return normalizeProductFields(record.data as Record<string, unknown>);
}

async function writeProductData(
	ctx: PluginContext,
	productId: string,
	patch: Record<string, unknown>,
): Promise<void> {
	if (!ctx.content) return;
	const update = ctx.content.update as ContentWriteOp | undefined;
	if (typeof update !== "function") return;
	await update.call(ctx.content, "products", productId, patch);
}

export async function restoreForOrderItem(
	ctx: PluginContext,
	input: RestoreInput,
): Promise<RestoreResult> {
	const { orderItem, quantity, reason, refundId, note } = input;
	if (quantity <= 0) return { newStock: null };

	if (orderItem.variantId) {
		const newStock = await adjustVariantStock(ctx, orderItem.variantId, quantity);
		if (newStock === null) return { newStock: null };
		await putLedgerEntry(ctx, {
			productId: orderItem.productId,
			variantId: orderItem.variantId,
			delta: quantity,
			newStockLevel: newStock,
			reason,
			orderId: orderItem.orderId,
			...(refundId ? { refundId } : {}),
			...(note ? { note } : {}),
		});
		return { newStock };
	}

	const product = await loadProductData(ctx, orderItem.productId);
	if (!product || !product.manageStock) return { newStock: null };
	const current = product.stockQuantity ?? 0;
	const next = current + quantity;
	// Emdash content updates expect snake_case field slugs.
	const patch: Record<string, unknown> = { stock_quantity: next };

	if (
		product.lowStockThreshold !== null &&
		product.lowStockThreshold !== undefined &&
		product.belowThresholdAt !== null &&
		next >= product.lowStockThreshold
	) {
		patch.below_threshold_at = null;
	}

	await writeProductData(ctx, orderItem.productId, patch);
	await putLedgerEntry(ctx, {
		productId: orderItem.productId,
		delta: quantity,
		newStockLevel: next,
		reason,
		orderId: orderItem.orderId,
		...(refundId ? { refundId } : {}),
		...(note ? { note } : {}),
	});
	return { newStock: next };
}

/**
 * Stock decrement on order-paid.
 *
 * For each order item:
 *   - If `variantId` is present → decrement via
 *     `products/variants.adjustVariantStock`.
 *   - Else if the product has `manageStock: true` → patch the host content
 *     item's `data.stockQuantity`.
 *
 * Either path writes an `inventory_ledger` entry. If the resulting stock
 * crosses below `lowStockThreshold` and `belowThresholdAt` was null, the
 * product is updated to stamp the timestamp — that's the low-stock alert
 * trigger (consumed by `orders/receipt.ts` + email in phase 15).
 */

import type { ContentAccess, PluginContext } from "emdash";
import { adjustVariantStock } from "../products/variants";
import { normalizeProductFields } from "../products/normalize";

/** Local alias: emdash's ContentAccessWithWrite is not re-exported. */
type ContentWriteOp = NonNullable<ContentAccess["update"]>;
import type { OrderItem, ProductFields } from "../types";
import { putLedgerEntry } from "./ledger";

export interface DecrementResult {
	/** `null` when stock is not tracked for this product/variant. */
	newStock: number | null;
	belowThreshold: boolean;
	/**
	 * `true` when the decrement was skipped because it would have driven
	 * stock below zero AND backorders were not configured. Callers
	 * should treat this as a hard error (order should not be fulfilled)
	 * and escalate — the cart-soft-lock + checkout stock check normally
	 * prevents this from ever firing, so if it does there's either a
	 * concurrent-webhook race (rare: Stripe retries for the same PI
	 * dedupe upstream) or a manual stock adjustment during flight.
	 */
	overSold?: true;
}

export class OversoldError extends Error {
	constructor(
		public readonly productId: string,
		public readonly variantId: string | undefined,
		public readonly requested: number,
		public readonly available: number,
	) {
		super(
			`Oversold: product ${productId}${variantId ? ` variant ${variantId}` : ""} requested ${requested} but only ${available} available`,
		);
		this.name = "OversoldError";
	}
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

/**
 * Decrement stock for an order item.
 *
 * Guards against oversell: if the current quantity is tracked and the
 * requested decrement would drive it negative, we refuse the write and
 * throw `OversoldError`. Order-creation callers treat this as a
 * critical error — the merchant should not ship a unit we didn't have.
 *
 * The soft-lock + checkout stock check normally prevent us from ever
 * reaching this branch, but defending here closes the door on two
 * edge cases:
 *   - Concurrent webhook delivery for the same product across two
 *     different orders (rare; Stripe retries for the same PI dedupe
 *     upstream, but different PIs against the last unit can race).
 *   - A merchant manually lowering stock in the admin between
 *     PaymentIntent creation and webhook arrival.
 */
export async function decrementForOrderItem(
	ctx: PluginContext,
	orderItem: OrderItem,
): Promise<DecrementResult> {
	const qty = orderItem.quantity;

	if (orderItem.variantId) {
		// Variant branch: adjustVariantStock returns null only when the
		// variant is not tracking stock. Otherwise it writes unconditionally
		// — we pre-check via a read so we can refuse on oversell rather
		// than silently landing negative stock.
		const { getVariant } = await import("../products/variants");
		const variant = await getVariant(ctx, orderItem.variantId);
		if (!variant) {
			throw new Error(`Variant ${orderItem.variantId} not found`);
		}
		if (variant.stockQuantity === null) {
			return { newStock: null, belowThreshold: false };
		}
		if (variant.stockQuantity < qty) {
			throw new OversoldError(
				orderItem.productId,
				orderItem.variantId,
				qty,
				variant.stockQuantity,
			);
		}
		const newStock = await adjustVariantStock(ctx, orderItem.variantId, -qty);
		if (newStock === null) return { newStock: null, belowThreshold: false };
		await putLedgerEntry(ctx, {
			productId: orderItem.productId,
			variantId: orderItem.variantId,
			delta: -qty,
			newStockLevel: newStock,
			reason: "order_paid",
			orderId: orderItem.orderId,
		});
		return { newStock, belowThreshold: false };
	}

	const product = await loadProductData(ctx, orderItem.productId);
	if (!product || !product.manageStock) {
		return { newStock: null, belowThreshold: false };
	}
	const current = product.stockQuantity ?? 0;
	if (current < qty) {
		throw new OversoldError(
			orderItem.productId,
			undefined,
			qty,
			current,
		);
	}
	const next = current - qty;
	// Emdash content updates are keyed by field slug (snake_case), not by
	// our camelCase runtime type. Hand emdash the slugs directly.
	const patch: Record<string, unknown> = { stock_quantity: next };

	let belowThreshold = false;
	if (
		product.lowStockThreshold !== null &&
		product.lowStockThreshold !== undefined &&
		next < product.lowStockThreshold &&
		product.belowThresholdAt === null
	) {
		patch.below_threshold_at = new Date().toISOString();
		belowThreshold = true;
	}

	await writeProductData(ctx, orderItem.productId, patch);
	await putLedgerEntry(ctx, {
		productId: orderItem.productId,
		delta: -qty,
		newStockLevel: next,
		reason: "order_paid",
		orderId: orderItem.orderId,
	});
	return { newStock: next, belowThreshold };
}

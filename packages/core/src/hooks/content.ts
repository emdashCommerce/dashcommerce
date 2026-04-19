/**
 * Product content-lifecycle validation.
 *
 * Runs on `content:beforeSave` when the content collection matches our
 * configured products slug. Throws on invalid commerce fields; the CMS
 * surfaces the error back to the admin editor.
 *
 * Validation covers:
 *   - `prices` is a non-empty PriceMap with integer `amount` fields
 *   - `sku` is non-empty and not whitespace
 *   - `stockQuantity` is non-negative when `manageStock` is true
 *   - `weightGrams` is non-negative when present
 *   - Product-type-specific required fields (grouped → childProductIds,
 *     external → productUrl, subscription → subscriptionConfig)
 */

import type { ContentHookEvent, PluginContext, StorageCollection } from "emdash";
import type { CurrencyCode, ProductFields, Vendor } from "../types";
import {
	productTypeRequiresChildren,
	productTypeRequiresExternalUrl,
	productTypeRequiresSubscriptionConfig,
} from "./../products/types";

export const PRODUCTS_COLLECTION_SLUG = "products";

export class ProductValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProductValidationError";
	}
}

export function validateProductFields(data: Partial<ProductFields>): void {
	const prices = data.prices;
	if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
		throw new ProductValidationError("`prices` must be an object keyed by currency code.");
	}
	const currencyCodes = Object.keys(prices);
	if (currencyCodes.length === 0) {
		throw new ProductValidationError("Product must have at least one currency price.");
	}
	for (const cc of currencyCodes) {
		const entry = prices[cc];
		if (!entry || typeof entry.amount !== "number" || !Number.isInteger(entry.amount)) {
			throw new ProductValidationError(
				`prices.${cc}.amount must be an integer minor-unit value.`,
			);
		}
		if (entry.amount < 0) {
			throw new ProductValidationError(`prices.${cc}.amount cannot be negative.`);
		}
		if (
			entry.compareAtAmount !== undefined &&
			(!Number.isInteger(entry.compareAtAmount) || entry.compareAtAmount < 0)
		) {
			throw new ProductValidationError(
				`prices.${cc}.compareAtAmount must be a non-negative integer when set.`,
			);
		}
	}

	if (typeof data.sku !== "string" || data.sku.trim() === "") {
		throw new ProductValidationError("SKU is required.");
	}

	if (data.manageStock === true) {
		const qty = data.stockQuantity;
		if (qty !== null && qty !== undefined && (!Number.isInteger(qty) || qty < 0)) {
			throw new ProductValidationError(
				"stockQuantity must be a non-negative integer when manageStock is true.",
			);
		}
	}

	if (data.weightGrams !== null && data.weightGrams !== undefined) {
		if (!Number.isInteger(data.weightGrams) || data.weightGrams < 0) {
			throw new ProductValidationError("weightGrams must be a non-negative integer.");
		}
	}

	if (data.type) {
		if (productTypeRequiresChildren(data.type)) {
			const kids = data.childProductIds;
			if (!Array.isArray(kids) || kids.length === 0) {
				throw new ProductValidationError(
					"Grouped products must have at least one childProductIds entry.",
				);
			}
		}
		if (productTypeRequiresExternalUrl(data.type)) {
			if (typeof data.productUrl !== "string" || !/^https?:\/\//.test(data.productUrl)) {
				throw new ProductValidationError(
					"External products require a productUrl starting with http(s)://.",
				);
			}
		}
		if (productTypeRequiresSubscriptionConfig(data.type)) {
			const cfg = data.subscriptionConfig;
			if (
				!cfg ||
				!["day", "week", "month", "year"].includes(cfg.interval) ||
				!Number.isInteger(cfg.intervalCount) ||
				cfg.intervalCount < 1
			) {
				throw new ProductValidationError(
					"Subscription products require a subscriptionConfig with interval + intervalCount ≥ 1.",
				);
			}
		}
	}
}

/**
 * Hook handler. Called by emdash with
 * `event = { collection, content, isNew }`.
 * Returning a `Record<string, unknown>` replaces the content being saved;
 * returning void keeps the incoming content. We return void for now —
 * validation only — and add enrichments (auto-sku, default stock_status)
 * in a follow-up.
 */
export async function productBeforeSave(
	event: ContentHookEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection !== PRODUCTS_COLLECTION_SLUG) return;
	const data = (event.content as { data?: Partial<ProductFields> }).data;
	if (!data) return;
	validateProductFields(data);
	await validateCurrencyCoverage(ctx, data);
	await validateVendorAssignment(ctx, data);
}

/**
 * Guarantee the product is sellable in the store's default currency. Without
 * this, operators could save a product priced only in EUR while the store
 * default is USD — every "Add to cart" from a fresh session (cart
 * defaults to the store default currency) would then 409 with "Product not
 * priced in USD" with no hint as to why.
 *
 * We only hard-fail on the default currency. Other `enabledCurrencies`
 * missing a price are a soft warning surfaced in the editor; an operator
 * may intentionally limit a product to a subset of markets.
 */
async function validateCurrencyCoverage(
	ctx: PluginContext,
	data: Partial<ProductFields>,
): Promise<void> {
	if (!data.prices) return; // validateProductFields already errored if missing
	const defaultCurrency =
		(await ctx.kv.get<CurrencyCode>("settings:defaultCurrency")) ?? "USD";
	const cc = defaultCurrency.toUpperCase();
	if (!data.prices[cc]) {
		throw new ProductValidationError(
			`Product must be priced in ${cc} (the store's default currency). Add a ${cc} price or change the default currency in Settings.`,
		);
	}
}

/**
 * Ensure `vendorId` is only set when multi-vendor marketplace is enabled,
 * and that the referenced vendor exists and can charge. When marketplace
 * is off we treat an incoming `vendorId` as operator error (they likely
 * pasted from a marketplace-enabled store, or the UI misbehaved) and
 * reject the save.
 */
async function validateVendorAssignment(
	ctx: PluginContext,
	data: Partial<ProductFields>,
): Promise<void> {
	const vendorId = data.vendorId;
	const connectEnabled =
		(await ctx.kv.get<boolean>("settings:connectEnabled")) === true;

	if (!vendorId || vendorId === "") {
		if (connectEnabled) {
			// Marketplace mode doesn't require a vendor on every product (drafts,
			// platform-sold items) — leave the product unassigned.
		}
		return;
	}

	if (!connectEnabled) {
		throw new ProductValidationError(
			"Cannot assign a vendor while multi-vendor marketplace is disabled. Turn it on in Settings or clear the vendor.",
		);
	}

	const store = (ctx.storage as unknown as { vendors?: StorageCollection<Vendor> })
		.vendors;
	if (!store) {
		throw new ProductValidationError(
			"Vendor storage is unavailable — cannot validate vendorId.",
		);
	}
	const vendor = (await store.get(vendorId)) as Vendor | null;
	if (!vendor) {
		throw new ProductValidationError(
			`Vendor ${vendorId} does not exist. Pick an onboarded vendor.`,
		);
	}
	if (!vendor.chargesEnabled) {
		throw new ProductValidationError(
			`Vendor "${vendor.name}" cannot yet receive charges (status: ${vendor.onboardingStatus}). Finish onboarding before assigning products.`,
		);
	}
}

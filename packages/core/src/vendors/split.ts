/**
 * Vendor split computation for checkout.
 *
 * Input: a (repriced) cart. Output: a plan describing how many Stripe
 * PaymentIntents to create, and for each, the amount, destination
 * (connected account), and platform fee.
 *
 * The split is computed over line subtotals (not grand total) — taxes
 * and shipping flow to the platform by default and are not split unless
 * a future setting flips that. This keeps the model predictable: the
 * vendor sees exactly their advertised item price, and the platform
 * eats the tax/shipping collection responsibility.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { add, money, percent as pct, zero, type Money } from "../money";
import type { CartLineItem, CartState, Vendor } from "../types";

type VendorStore = StorageCollection<Vendor>;
function vendorsStore(ctx: PluginContext): VendorStore {
	return (ctx.storage as unknown as { vendors: VendorStore }).vendors;
}

export interface VendorGroup {
	vendorId: string;
	stripeAccountId: string;
	platformFeePercent: number;
	itemsSubtotal: Money;
	applicationFee: Money;
	vendorAmount: Money;
	items: CartLineItem[];
}

export interface SplitPlan {
	currency: string;
	/** When the cart has no vendor-owned items → classic single-PI flow. */
	mode: "platform" | "single-vendor" | "multi-vendor";
	/** Group whose items belong to the platform (no vendorId). */
	platformGroup?: {
		subtotal: Money;
		items: CartLineItem[];
	};
	vendorGroups: VendorGroup[];
	/** Tax + shipping go to platform in this model. */
	nonSplitTotal: Money;
	/** Grand total (equal to cart.total; restated here for assertion). */
	grandTotal: Money;
}

async function loadVendor(ctx: PluginContext, vendorId: string): Promise<Vendor | null> {
	const raw = await vendorsStore(ctx).get(vendorId);
	if (!raw) return null;
	return { ...(raw as Vendor), id: vendorId };
}

async function readGlobalFee(ctx: PluginContext): Promise<number> {
	return (await ctx.kv.get<number>("settings:connectPlatformFeePercent")) ?? 10;
}

/** Is Stripe Connect turned on at the store level? */
export async function connectEnabled(ctx: PluginContext): Promise<boolean> {
	return (await ctx.kv.get<boolean>("settings:connectEnabled")) ?? false;
}

export async function computeSplit(
	ctx: PluginContext,
	cart: CartState,
): Promise<SplitPlan> {
	const currency = cart.currency;
	const globalFeePct = await readGlobalFee(ctx);

	const buckets = new Map<string, CartLineItem[]>();
	const platformItems: CartLineItem[] = [];
	for (const item of cart.items) {
		if (item.vendorId) {
			const list = buckets.get(item.vendorId) ?? [];
			list.push(item);
			buckets.set(item.vendorId, list);
		} else {
			platformItems.push(item);
		}
	}

	const vendorGroups: VendorGroup[] = [];
	for (const [vendorId, items] of buckets) {
		const vendor = await loadVendor(ctx, vendorId);
		if (!vendor) {
			throw new Error(`Vendor ${vendorId} referenced by cart not found`);
		}
		if (!vendor.chargesEnabled) {
			throw new Error(
				`Vendor ${vendor.name} (${vendor.stripeAccountId}) cannot accept charges yet`,
			);
		}
		const subtotal = items.reduce<Money>(
			(acc, it) => add(acc, it.lineSubtotal),
			zero(currency),
		);
		const feePct = vendor.platformFeePercent > 0 ? vendor.platformFeePercent : globalFeePct;
		const applicationFee = pct(subtotal, feePct);
		const vendorAmount = money(currency, subtotal.amount - applicationFee.amount);
		vendorGroups.push({
			vendorId: vendor.id,
			stripeAccountId: vendor.stripeAccountId,
			platformFeePercent: feePct,
			itemsSubtotal: subtotal,
			applicationFee,
			vendorAmount,
			items,
		});
	}

	const platformSubtotal = platformItems.reduce<Money>(
		(acc, it) => add(acc, it.lineSubtotal),
		zero(currency),
	);
	const nonSplit = money(
		currency,
		cart.shippingTotal.amount + cart.taxTotal.amount,
	);

	const mode: SplitPlan["mode"] =
		vendorGroups.length === 0
			? "platform"
			: vendorGroups.length === 1 && platformItems.length === 0
				? "single-vendor"
				: "multi-vendor";

	return {
		currency,
		mode,
		...(platformItems.length > 0
			? { platformGroup: { subtotal: platformSubtotal, items: platformItems } }
			: {}),
		vendorGroups,
		nonSplitTotal: nonSplit,
		grandTotal: cart.total,
	};
}

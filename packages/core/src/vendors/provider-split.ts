/**
 * Provider-neutral vendor split computation.
 *
 * The Stripe Connect plan in `split.ts` describes destination charges and
 * application fees. This one produces what any provider that declares
 * `capabilities.splits` needs: an exact minor-unit amount per vendor account
 * plus the platform remainder. Core owns the arithmetic; a provider must not
 * reprice or invent shares.
 *
 * The model matches Stripe Connect: the split is over line subtotals, and
 * tax, shipping and the platform fee stay with the platform. A vendor sees
 * exactly their advertised item price minus the configured platform fee.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { type Money, money, percent as pct } from "../money";
import type { PaymentProviderSplitAllocation } from "../payment-provider";
import type { CartLineItem, CartState, CurrencyCode, Vendor } from "../types";

type VendorStore = StorageCollection<Vendor>;
function vendorsStore(ctx: PluginContext): VendorStore {
	return (ctx.storage as unknown as { vendors: VendorStore }).vendors;
}

export interface ProviderSplitPlan {
	currency: string;
	allocations: PaymentProviderSplitAllocation[];
	/** Total minus every allocation: tax, shipping, platform items and fees. */
	platformRemainderMinor: number;
}

async function loadVendor(ctx: PluginContext, vendorId: string): Promise<Vendor | null> {
	const raw = await vendorsStore(ctx).get(vendorId);
	if (!raw) return null;
	return { ...(raw as Vendor), id: vendorId };
}

async function readGlobalFee(ctx: PluginContext): Promise<number> {
	return (await ctx.kv.get<number>("settings:connectPlatformFeePercent")) ?? 10;
}

function sumSubtotal(items: readonly CartLineItem[], currency: string): Money {
	let total = 0;
	for (const item of items) {
		if (item.lineSubtotal.currency.toUpperCase() !== currency) {
			throw new Error(`Cart line ${item.lineId} is not in ${currency}`);
		}
		if (!Number.isSafeInteger(item.lineSubtotal.amount) || item.lineSubtotal.amount < 0) {
			throw new Error(`Cart line ${item.lineId} has an invalid subtotal`);
		}
		total += item.lineSubtotal.amount;
	}
	if (!Number.isSafeInteger(total)) {
		throw new Error("Cart subtotal exceeds the safe integer range");
	}
	return money(currency as CurrencyCode, total);
}

/**
 * Build the allocations for a cart that has vendor-owned items.
 *
 * Throws with a merchant-readable message when a vendor is missing, has no
 * active account for this provider, settles in another currency, or when the
 * shares do not fit inside the cart total. The caller turns that into a 409
 * rather than silently charging the platform account.
 */
export async function computeProviderSplit(
	ctx: PluginContext,
	cart: CartState,
	providerId: string,
): Promise<ProviderSplitPlan> {
	const currency = cart.currency.trim().toUpperCase();
	if (!/^[A-Z]{3}$/u.test(currency)) {
		throw new Error("Cart currency must be an ISO 4217 code");
	}
	if (cart.total.currency.toUpperCase() !== currency) {
		throw new Error("Cart total currency does not match the cart currency");
	}
	if (!Number.isSafeInteger(cart.total.amount) || cart.total.amount < 0) {
		throw new Error("Cart total must be a non-negative safe integer in minor units");
	}

	const buckets = new Map<string, CartLineItem[]>();
	for (const item of cart.items) {
		if (!item.vendorId) continue;
		const list = buckets.get(item.vendorId) ?? [];
		list.push(item);
		buckets.set(item.vendorId, list);
	}

	const globalFeePercent = await readGlobalFee(ctx);
	const allocations: PaymentProviderSplitAllocation[] = [];
	let allocated = 0;

	for (const [vendorId, items] of buckets) {
		const vendor = await loadVendor(ctx, vendorId);
		if (!vendor) {
			throw new Error(`Vendor ${vendorId} referenced by the cart was not found`);
		}
		const account = vendor.paymentAccounts?.[providerId];
		if (!account || !account.accountReference.trim()) {
			throw new Error(
				`Vendor ${vendor.name} has no ${providerId} payout account. Add one in Vendors before taking a split payment.`,
			);
		}
		if (account.status !== "active") {
			throw new Error(
				`Vendor ${vendor.name}'s ${providerId} payout account is ${account.status}, not active`,
			);
		}
		if (account.currency && account.currency.toUpperCase() !== currency) {
			throw new Error(
				`Vendor ${vendor.name}'s ${providerId} account settles in ${account.currency}, but the cart is in ${currency}`,
			);
		}

		const subtotal = sumSubtotal(items, currency);
		const feePercent = vendor.platformFeePercent > 0 ? vendor.platformFeePercent : globalFeePercent;
		if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
			throw new Error(`Vendor ${vendor.name} has an invalid platform fee percentage`);
		}
		const platformFee = pct(subtotal, feePercent);
		const vendorAmount = subtotal.amount - platformFee.amount;
		if (!Number.isSafeInteger(vendorAmount) || vendorAmount <= 0) {
			throw new Error(
				`Vendor ${vendor.name}'s share must be positive; check the platform fee and the line prices`,
			);
		}
		allocated += vendorAmount;
		if (!Number.isSafeInteger(allocated)) {
			throw new Error("Vendor allocations exceed the safe integer range");
		}
		allocations.push({
			vendorId: vendor.id,
			accountReference: account.accountReference.trim(),
			amountMinor: vendorAmount,
		});
	}

	if (allocated > cart.total.amount) {
		throw new Error(
			`Vendor allocations (${allocated}) exceed the cart total (${cart.total.amount})`,
		);
	}

	return {
		currency,
		allocations,
		platformRemainderMinor: cart.total.amount - allocated,
	};
}

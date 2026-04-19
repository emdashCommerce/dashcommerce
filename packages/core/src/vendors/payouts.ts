/**
 * Vendor payout mirroring.
 *
 * Stripe pushes payout events via `payout.paid` / `payout.failed` on
 * connected accounts. We persist each into `vendor_payouts` with
 * uniqueIndexes: ["stripePayoutId"], so retries dedupe on put.
 *
 * Admin UI can also trigger a full sync via
 * `listPayouts(vendor.stripeAccountId)` — see Stripe's list endpoint.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import { money } from "../money";
import type { VendorPayout } from "../types";
import type { StripeClientOptions } from "../stripe/client";
import { listPayouts, type StripePayout } from "../stripe/connect";
import { findVendorByStripeAccountId } from "./onboarding";

type PayoutsStore = StorageCollection<VendorPayout>;
function payoutsStore(ctx: PluginContext): PayoutsStore {
	return (ctx.storage as unknown as { vendor_payouts: PayoutsStore }).vendor_payouts;
}

export async function recordPayoutFromStripe(
	ctx: PluginContext,
	stripeAccountId: string,
	stripePayout: StripePayout,
): Promise<VendorPayout | null> {
	const vendor = await findVendorByStripeAccountId(ctx, stripeAccountId);
	if (!vendor) {
		ctx.log.warn("payout for unknown vendor", {
			stripeAccountId,
			stripePayoutId: stripePayout.id,
		});
		return null;
	}
	// Dedup on stripePayoutId (unique-indexed).
	const existing = await payoutsStore(ctx).query({
		where: { stripePayoutId: stripePayout.id },
		limit: 1,
	});
	const prevRow = existing.items[0];
	const id = prevRow?.id ?? randomId();
	const record: VendorPayout = {
		id,
		vendorId: vendor.id,
		stripePayoutId: stripePayout.id,
		amount: money(stripePayout.currency.toUpperCase(), stripePayout.amount),
		status: stripePayout.status,
		arrivalDate: new Date(stripePayout.arrival_date * 1000).toISOString(),
		createdAt:
			(prevRow?.data as VendorPayout | undefined)?.createdAt ??
			new Date().toISOString(),
	};
	await payoutsStore(ctx).put(id, record);
	return record;
}

export interface SyncPayoutsInput {
	vendorId: string;
	sinceSeconds?: number;
	client: StripeClientOptions;
}

export async function syncPayoutsFromStripe(
	ctx: PluginContext,
	input: SyncPayoutsInput,
): Promise<{ imported: number }> {
	const vendor = await (async () => {
		const raw = await (
			ctx.storage as unknown as {
				vendors: { get(id: string): Promise<unknown> };
			}
		).vendors.get(input.vendorId);
		if (!raw) return null;
		return { ...(raw as { stripeAccountId: string }), id: input.vendorId };
	})();
	if (!vendor?.stripeAccountId) {
		throw new Error(`Vendor ${input.vendorId} has no stripeAccountId`);
	}
	let imported = 0;
	let startingAfter: string | undefined;
	for (let pages = 0; pages < 20; pages += 1) {
		const res = await listPayouts(
			ctx,
			{
				account: vendor.stripeAccountId,
				limit: 100,
				...(startingAfter ? { startingAfter } : {}),
				...(input.sinceSeconds !== undefined
					? { arrivalDateGte: input.sinceSeconds }
					: {}),
			},
			input.client,
		);
		for (const p of res.data) {
			await recordPayoutFromStripe(ctx, vendor.stripeAccountId, p);
			imported += 1;
		}
		if (!res.has_more || res.data.length === 0) break;
		startingAfter = res.data[res.data.length - 1]?.id;
		if (!startingAfter) break;
	}
	return { imported };
}

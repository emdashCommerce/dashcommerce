/**
 * Vendor onboarding orchestration.
 *
 * The merchant creates a vendor record in the admin UI; the vendor then
 * clicks a link that lands us at `startOnboarding`, which:
 *   1. Looks up (or creates) the Stripe Account for this vendor email.
 *   2. Generates an AccountLink with refresh/return URLs pointing back at
 *      the storefront onboarding page.
 *   3. Persists stripeAccountId + initial vendor row if not present.
 *
 * The returned `url` is a one-time, short-TTL Stripe-hosted URL the vendor
 * follows to complete KYC. Onboarding state updates arrive via the
 * `account.updated` webhook.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import type { Vendor } from "../types";
import { sendVendorInvite } from "../emails";
import type { StripeClientOptions } from "../stripe/client";
import {
	createAccount,
	createAccountLink,
	retrieveAccount,
	type StripeAccount,
} from "../stripe/connect";

type VendorStore = StorageCollection<Vendor>;
function vendorsStore(ctx: PluginContext): VendorStore {
	return (ctx.storage as unknown as { vendors: VendorStore }).vendors;
}

export interface StartOnboardingInput {
	vendorId?: string;
	email: string;
	name: string;
	country?: string;
	refreshUrl: string;
	returnUrl: string;
	platformFeePercent?: number;
	client: StripeClientOptions;
}

export interface StartOnboardingResult {
	vendor: Vendor;
	url: string;
	expiresAt: string;
}

export async function findVendorByEmail(
	ctx: PluginContext,
	email: string,
): Promise<Vendor | null> {
	const res = await vendorsStore(ctx).query({ where: { email }, limit: 1 });
	const row = res.items[0];
	if (!row) return null;
	return { ...(row.data as Vendor), id: row.id };
}

export async function findVendorByStripeAccountId(
	ctx: PluginContext,
	stripeAccountId: string,
): Promise<Vendor | null> {
	const res = await vendorsStore(ctx).query({
		where: { stripeAccountId },
		limit: 1,
	});
	const row = res.items[0];
	if (!row) return null;
	return { ...(row.data as Vendor), id: row.id };
}

export async function getVendor(
	ctx: PluginContext,
	vendorId: string,
): Promise<Vendor | null> {
	const raw = await vendorsStore(ctx).get(vendorId);
	if (!raw) return null;
	return { ...(raw as Vendor), id: vendorId };
}

export async function startOnboarding(
	ctx: PluginContext,
	input: StartOnboardingInput,
): Promise<StartOnboardingResult> {
	let vendor: Vendor | null = input.vendorId
		? await getVendor(ctx, input.vendorId)
		: await findVendorByEmail(ctx, input.email.toLowerCase());

	let stripeAccount: StripeAccount;
	if (!vendor || !vendor.stripeAccountId) {
		stripeAccount = await createAccount(
			ctx,
			{
				email: input.email,
				country: input.country,
				type: "express",
				metadata: {
					dashcommerceVendorId: vendor?.id ?? "",
				},
			},
			input.client,
			`vendor-acct:${vendor?.id ?? input.email.toLowerCase()}`,
		);
	} else {
		stripeAccount = await retrieveAccount(ctx, vendor.stripeAccountId, input.client);
	}

	const now = new Date().toISOString();
	if (!vendor) {
		vendor = {
			id: randomId(),
			stripeAccountId: stripeAccount.id,
			name: input.name,
			email: input.email.toLowerCase(),
			onboardingStatus: "pending",
			platformFeePercent: input.platformFeePercent ?? 0,
			detailsSubmitted: !!stripeAccount.details_submitted,
			chargesEnabled: !!stripeAccount.charges_enabled,
			payoutsEnabled: !!stripeAccount.payouts_enabled,
			createdAt: now,
			updatedAt: now,
		};
	} else {
		vendor = {
			...vendor,
			stripeAccountId: stripeAccount.id,
			detailsSubmitted: !!stripeAccount.details_submitted,
			chargesEnabled: !!stripeAccount.charges_enabled,
			payoutsEnabled: !!stripeAccount.payouts_enabled,
			updatedAt: now,
		};
	}
	await vendorsStore(ctx).put(vendor.id, vendor);

	const link = await createAccountLink(
		ctx,
		{
			account: stripeAccount.id,
			refreshUrl: input.refreshUrl,
			returnUrl: input.returnUrl,
		},
		input.client,
		`vendor-link:${vendor.id}:${Date.now()}`,
	);

	// Fire-and-forget invite email. `sendVendorInvite` swallows provider
	// errors; the onboarding URL is also returned from this function so
	// the caller can surface it in the admin UI as a backup channel.
	await sendVendorInvite(ctx, vendor, link.url);

	return {
		vendor,
		url: link.url,
		expiresAt: new Date(link.expires_at * 1000).toISOString(),
	};
}

export async function upsertVendorFromStripeAccount(
	ctx: PluginContext,
	account: StripeAccount,
): Promise<Vendor | null> {
	const existing = await findVendorByStripeAccountId(ctx, account.id);
	if (!existing) return null;
	const updated: Vendor = {
		...existing,
		detailsSubmitted: !!account.details_submitted,
		chargesEnabled: !!account.charges_enabled,
		payoutsEnabled: !!account.payouts_enabled,
		onboardingStatus: account.charges_enabled
			? "active"
			: account.details_submitted
				? "restricted"
				: "pending",
		updatedAt: new Date().toISOString(),
	};
	await vendorsStore(ctx).put(existing.id, updated);
	return updated;
}

/**
 * Subscription lifecycle — merchant + customer self-service actions.
 *
 * Stripe subscriptions call Stripe first (with Idempotency-Key) and wait for
 * the resulting `customer.subscription.updated` webhook to refresh the local
 * row. Provider-managed subscriptions (Flutterwave Payment Plans) call the
 * provider and update the local row immediately, because their cancellation
 * is not delivered as a subscription webhook.
 */

import type { PluginContext } from "emdash";
import {
	type ProviderSubscriptionInfo,
	loadPaymentProviderCredentials,
	requirePaymentProvider,
} from "../payment-provider";
import type { StripeClientOptions } from "../stripe/client";
import {
	cancelSubscription as stripeCancel,
	updateSubscription as stripeUpdate,
	type StripeSubscription,
} from "../stripe/subscriptions";
import type { Subscription } from "../types";
import { findSubscription, subsStore } from "./create";

export type CancelMode = "immediate" | "at_period_end";

export interface CancelInput {
	subscriptionId: string; // our local id
	mode: CancelMode;
	/** Required for Stripe; ignored for a provider-managed subscription. */
	client?: StripeClientOptions;
}

export async function cancel(
	ctx: PluginContext,
	input: CancelInput,
): Promise<StripeSubscription | ProviderSubscriptionInfo> {
	const local = await loadLocal(ctx, input.subscriptionId);
	if (isProviderManaged(local)) {
		const info = await providerCancel(ctx, local, input.mode);
		await saveProviderState(ctx, local, info, {
			cancelAtPeriodEnd: info.cancelAtPeriodEnd ?? input.mode === "at_period_end",
			canceledAt:
				info.status === "canceled" ? (info.canceledAt ?? new Date().toISOString()) : undefined,
		});
		return info;
	}

	const client = requireStripeClient(input.client);
	const idemKey = `sub-cancel:${local.stripeSubscriptionId}:${input.mode}`;
	if (input.mode === "immediate") {
		return stripeCancel(ctx, local.stripeSubscriptionId, client, idemKey);
	}
	return stripeUpdate(
		ctx,
		local.stripeSubscriptionId,
		{ cancelAtPeriodEnd: true },
		client,
		idemKey,
	);
}

export interface PauseInput {
	subscriptionId: string;
	behavior?: "keep_as_draft" | "mark_uncollectible" | "void";
	resumesAt?: number; // unix seconds
	client?: StripeClientOptions;
}

export async function pause(ctx: PluginContext, input: PauseInput): Promise<StripeSubscription> {
	const local = await loadLocal(ctx, input.subscriptionId);
	if (isProviderManaged(local)) {
		throw new Error(`${local.providerId} does not support pausing subscriptions`);
	}
	const client = requireStripeClient(input.client);
	const idemKey = `sub-pause:${local.stripeSubscriptionId}:${input.resumesAt ?? "open"}`;
	return stripeUpdate(
		ctx,
		local.stripeSubscriptionId,
		{
			pauseCollection: {
				behavior: input.behavior ?? "mark_uncollectible",
				...(input.resumesAt !== undefined ? { resumesAt: input.resumesAt } : {}),
			},
		},
		client,
		idemKey,
	);
}

export interface ResumeInput {
	subscriptionId: string;
	client?: StripeClientOptions;
}

export async function resume(
	ctx: PluginContext,
	input: ResumeInput,
): Promise<StripeSubscription | ProviderSubscriptionInfo> {
	const local = await loadLocal(ctx, input.subscriptionId);
	if (isProviderManaged(local)) {
		const info = await providerResume(ctx, local);
		await saveProviderState(ctx, local, info, {
			cancelAtPeriodEnd: false,
			canceledAt: undefined,
		});
		return info;
	}

	const client = requireStripeClient(input.client);
	const idemKey = `sub-resume:${local.stripeSubscriptionId}`;
	return stripeUpdate(ctx, local.stripeSubscriptionId, { pauseCollection: null }, client, idemKey);
}

export interface ChangePlanInput {
	subscriptionId: string;
	/** Stripe subscription-item id to update. */
	stripeItemId: string;
	newPriceId: string;
	quantity?: number;
	prorationBehavior?: "create_prorations" | "none" | "always_invoice";
	client?: StripeClientOptions;
}

export async function changePlan(
	ctx: PluginContext,
	input: ChangePlanInput,
): Promise<StripeSubscription> {
	const local = await loadLocal(ctx, input.subscriptionId);
	if (isProviderManaged(local)) {
		throw new Error(`${local.providerId} does not support changing plans in place`);
	}
	const client = requireStripeClient(input.client);
	const idemKey = `sub-change:${local.stripeSubscriptionId}:${input.newPriceId}`;
	return stripeUpdate(
		ctx,
		local.stripeSubscriptionId,
		{
			items: [
				{
					id: input.stripeItemId,
					price: input.newPriceId,
					...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
				},
			],
			prorationBehavior: input.prorationBehavior ?? "create_prorations",
		},
		client,
		idemKey,
	);
}

function isProviderManaged(sub: Subscription): boolean {
	return Boolean(sub.providerId && sub.providerId !== "stripe");
}

function requireStripeClient(client: StripeClientOptions | undefined): StripeClientOptions {
	if (!client) throw new Error("Stripe not configured");
	return client;
}

async function providerCancel(
	ctx: PluginContext,
	local: Subscription,
	mode: CancelMode,
): Promise<ProviderSubscriptionInfo> {
	const provider = requirePaymentProvider(local.providerId ?? "");
	if (!provider.cancelSubscription) {
		throw new Error(`${provider.label} does not support cancelling subscriptions`);
	}
	const creds = await loadPaymentProviderCredentials(ctx.kv, provider.id);
	if (!creds) throw new Error(`Payment provider "${provider.id}" is not configured`);
	return provider.cancelSubscription(
		ctx,
		{
			providerSubscriptionId: local.stripeSubscriptionId,
			atPeriodEnd: mode === "at_period_end",
		},
		creds,
	);
}

async function providerResume(
	ctx: PluginContext,
	local: Subscription,
): Promise<ProviderSubscriptionInfo> {
	const provider = requirePaymentProvider(local.providerId ?? "");
	if (!provider.resumeSubscription) {
		throw new Error(`${provider.label} does not support resuming subscriptions`);
	}
	const creds = await loadPaymentProviderCredentials(ctx.kv, provider.id);
	if (!creds) throw new Error(`Payment provider "${provider.id}" is not configured`);
	return provider.resumeSubscription(
		ctx,
		{ providerSubscriptionId: local.stripeSubscriptionId },
		creds,
	);
}

async function saveProviderState(
	ctx: PluginContext,
	local: Subscription,
	info: ProviderSubscriptionInfo,
	extra: { cancelAtPeriodEnd?: boolean; canceledAt?: string | undefined },
): Promise<void> {
	const now = new Date().toISOString();
	await subsStore(ctx).put(local.id, {
		...local,
		status: info.status,
		...(info.currentPeriodStart ? { currentPeriodStart: info.currentPeriodStart } : {}),
		...(info.currentPeriodEnd ? { currentPeriodEnd: info.currentPeriodEnd } : {}),
		cancelAtPeriodEnd: extra.cancelAtPeriodEnd ?? local.cancelAtPeriodEnd,
		...(extra.canceledAt ? { canceledAt: extra.canceledAt } : {}),
		updatedAt: now,
	});
}

async function loadLocal(ctx: PluginContext, id: string): Promise<Subscription> {
	// Accept either our uuid or the provider id for convenience.
	const directRes = await (
		ctx.storage as unknown as {
			subscriptions: { get(id: string): Promise<Subscription | null> };
		}
	).subscriptions.get(id);
	if (directRes) return { ...(directRes as Subscription), id };
	const byProvider = await findSubscription(ctx, id);
	if (byProvider) return byProvider;
	throw new Error(`Subscription ${id} not found`);
}

/**
 * Subscription lifecycle — merchant + customer self-service actions.
 *
 * All paths call Stripe first (with Idempotency-Key) and then wait for the
 * resulting `customer.subscription.updated` webhook to refresh our local
 * row — we do NOT optimistically mutate local state, to keep Stripe the
 * single source of truth.
 */

import type { PluginContext } from "emdash";
import type { StripeClientOptions } from "../stripe/client";
import {
	cancelSubscription as stripeCancel,
	updateSubscription as stripeUpdate,
	type StripeSubscription,
} from "../stripe/subscriptions";
import type { Subscription } from "../types";
import { findSubscription } from "./create";

export type CancelMode = "immediate" | "at_period_end";

export interface CancelInput {
	subscriptionId: string; // our local id
	mode: CancelMode;
	client: StripeClientOptions;
}

export async function cancel(
	ctx: PluginContext,
	input: CancelInput,
): Promise<StripeSubscription> {
	const local = await loadLocal(ctx, input.subscriptionId);
	const idemKey = `sub-cancel:${local.stripeSubscriptionId}:${input.mode}`;
	if (input.mode === "immediate") {
		return stripeCancel(ctx, local.stripeSubscriptionId, input.client, idemKey);
	}
	return stripeUpdate(
		ctx,
		local.stripeSubscriptionId,
		{ cancelAtPeriodEnd: true },
		input.client,
		idemKey,
	);
}

export interface PauseInput {
	subscriptionId: string;
	behavior?: "keep_as_draft" | "mark_uncollectible" | "void";
	resumesAt?: number; // unix seconds
	client: StripeClientOptions;
}

export async function pause(
	ctx: PluginContext,
	input: PauseInput,
): Promise<StripeSubscription> {
	const local = await loadLocal(ctx, input.subscriptionId);
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
		input.client,
		idemKey,
	);
}

export interface ResumeInput {
	subscriptionId: string;
	client: StripeClientOptions;
}

export async function resume(
	ctx: PluginContext,
	input: ResumeInput,
): Promise<StripeSubscription> {
	const local = await loadLocal(ctx, input.subscriptionId);
	const idemKey = `sub-resume:${local.stripeSubscriptionId}`;
	return stripeUpdate(
		ctx,
		local.stripeSubscriptionId,
		{ pauseCollection: null },
		input.client,
		idemKey,
	);
}

export interface ChangePlanInput {
	subscriptionId: string;
	/** Stripe subscription-item id to update. */
	stripeItemId: string;
	newPriceId: string;
	quantity?: number;
	prorationBehavior?: "create_prorations" | "none" | "always_invoice";
	client: StripeClientOptions;
}

export async function changePlan(
	ctx: PluginContext,
	input: ChangePlanInput,
): Promise<StripeSubscription> {
	const local = await loadLocal(ctx, input.subscriptionId);
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
		input.client,
		idemKey,
	);
}

async function loadLocal(ctx: PluginContext, id: string): Promise<Subscription> {
	// Accept either our uuid or the Stripe id for convenience.
	const directRes = await (ctx.storage as unknown as {
		subscriptions: { get(id: string): Promise<Subscription | null> };
	}).subscriptions.get(id);
	if (directRes) return { ...(directRes as Subscription), id };
	const byStripe = await findSubscription(ctx, id);
	if (byStripe) return byStripe;
	throw new Error(`Subscription ${id} not found`);
}

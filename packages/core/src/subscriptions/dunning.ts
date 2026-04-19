/**
 * Dunning on invoice.payment_failed.
 *
 * Stripe handles retry cadence (Smart Retries by default). Our job:
 *   1. Mirror the failed invoice into `subscription_invoices`.
 *   2. Mark the local subscription `past_due` (Stripe already will — but
 *      webhook ordering can leave us lagging; set it defensively).
 *   3. Send a dunning email to the customer (the same pattern as
 *      `orders/receipt.ts` — swallow errors if no email provider).
 *   4. Record a "last dunning sent" timestamp on the subscription so we
 *      don't email on every retry.
 */

import type { PluginContext } from "emdash";
import { composeDunning } from "../emails";
import type { Customer, Subscription, SubscriptionInvoice } from "../types";
import { subsStore, upsertInvoiceFromStripe } from "./create";
import type { StripeInvoice } from "../stripe/subscriptions";

const DUNNING_COOLDOWN_HOURS = 24;
const DUNNING_SENT_KEY = (subId: string) => `state:dunningSentAt:${subId}`;

export async function handleInvoicePaymentFailed(
	ctx: PluginContext,
	inv: StripeInvoice,
): Promise<void> {
	const invoiceRow = await upsertInvoiceFromStripe(ctx, inv);
	if (!invoiceRow) return;

	// Load the subscription + customer.
	const sub = await (
		ctx.storage as unknown as {
			subscriptions: { get(id: string): Promise<Subscription | null> };
		}
	).subscriptions.get(invoiceRow.subscriptionId);
	if (!sub) return;

	// Defensively flip to past_due.
	if (sub.status !== "past_due" && sub.status !== "canceled") {
		await subsStore(ctx).put(invoiceRow.subscriptionId, {
			...sub,
			status: "past_due",
			updatedAt: new Date().toISOString(),
		});
	}

	await maybeSendDunningEmail(ctx, invoiceRow, sub);
}

async function maybeSendDunningEmail(
	ctx: PluginContext,
	invoice: SubscriptionInvoice,
	sub: Subscription,
): Promise<void> {
	if (!ctx.email) return;
	const cooldownKey = DUNNING_SENT_KEY(sub.id);
	const lastRaw = await ctx.kv.get<string>(cooldownKey);
	if (lastRaw) {
		const last = Date.parse(lastRaw);
		if (Number.isFinite(last) && Date.now() - last < DUNNING_COOLDOWN_HOURS * 3_600_000) {
			return;
		}
	}

	const customer = await (
		ctx.storage as unknown as {
			customers: { get(id: string): Promise<Customer | null> };
		}
	).customers.get(sub.customerId);
	if (!customer?.email) return;

	const { subject, text, html } = composeDunning({
		customer,
		subscription: sub,
		invoice,
		siteName: ctx.site.name,
	});

	try {
		await ctx.email.send({ to: customer.email, subject, text, html });
		await ctx.kv.set(cooldownKey, new Date().toISOString());
	} catch (err) {
		ctx.log.warn("Dunning email send failed", {
			subscriptionId: sub.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

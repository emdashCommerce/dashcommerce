/**
 * Subscription storage helpers — idempotent upsert from Stripe events.
 *
 * Upsert keyed on `stripeSubscriptionId` (unique-indexed). Invoice upserts
 * key on `stripeInvoiceId` (unique-indexed).
 *
 * The public self-service route + dunning logic read these rows; they are
 * NEVER the source of truth for payment state — Stripe is. We mirror so
 * admin UI and notifications don't require a round-trip per render.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import type {
	Customer,
	IsoDateTime,
	Subscription,
	SubscriptionInvoice,
	SubscriptionStatus,
} from "../types";
import { money } from "../money";
import type { StripeInvoice, StripeSubscription } from "../stripe/subscriptions";

type SubsStore = StorageCollection<Subscription>;
type SubsInvoiceStore = StorageCollection<SubscriptionInvoice>;
type CustomersStore = StorageCollection<Customer>;

export function subsStore(ctx: PluginContext): SubsStore {
	return (ctx.storage as unknown as { subscriptions: SubsStore }).subscriptions;
}
function invoiceStore(ctx: PluginContext): SubsInvoiceStore {
	return (ctx.storage as unknown as { subscription_invoices: SubsInvoiceStore })
		.subscription_invoices;
}
function customersStore(ctx: PluginContext): CustomersStore {
	return (ctx.storage as unknown as { customers: CustomersStore }).customers;
}

function secsToIso(s?: number | null): IsoDateTime | undefined {
	if (!s) return undefined;
	return new Date(s * 1000).toISOString();
}

export async function findSubscription(
	ctx: PluginContext,
	stripeSubscriptionId: string,
): Promise<Subscription | null> {
	const result = await subsStore(ctx).query({
		where: { stripeSubscriptionId },
		limit: 1,
	});
	const row = result.items[0];
	if (!row) return null;
	return { ...(row.data as Subscription), id: row.id };
}

async function resolveCustomerId(
	ctx: PluginContext,
	stripeCustomerId: string,
): Promise<string | null> {
	// Match via stripeCustomerId stored on the customer row. Customers with
	// prior orders will already have this. For subscription-first sign-ups
	// we'd need an additional lookup, but at v1.0 every subscription comes
	// from an order path that already upserted the customer.
	const res = await customersStore(ctx).query({
		where: { stripeCustomerId },
		limit: 1,
	});
	const row = res.items[0];
	return row ? row.id : null;
}

export async function upsertFromStripe(
	ctx: PluginContext,
	sub: StripeSubscription,
): Promise<Subscription> {
	const existing = await findSubscription(ctx, sub.id);

	const item = sub.items?.data?.[0];
	if (!item) throw new Error(`Stripe subscription ${sub.id} has no items`);
	const price = item.price;
	const now = new Date().toISOString();
	const currency = price.currency.toUpperCase();

	const customerId =
		existing?.customerId ?? (await resolveCustomerId(ctx, sub.customer)) ?? "";
	if (!customerId) {
		ctx.log.warn("Subscription upsert: no customer row for Stripe customer id", {
			stripeCustomerId: sub.customer,
			stripeSubscriptionId: sub.id,
		});
	}

	const productId =
		existing?.productId ?? sub.metadata?.dashcommerceProductId ?? "";
	const variantId = existing?.variantId ?? sub.metadata?.dashcommerceVariantId;

	const record: Subscription = {
		id: existing?.id ?? randomId(),
		stripeSubscriptionId: sub.id,
		customerId,
		productId,
		...(variantId ? { variantId } : {}),
		status: sub.status as SubscriptionStatus,
		currency,
		unitAmount: money(currency, price.unit_amount),
		quantity: item.quantity,
		interval:
			(price.recurring?.interval as Subscription["interval"]) ??
			existing?.interval ??
			"month",
		intervalCount:
			price.recurring?.interval_count ?? existing?.intervalCount ?? 1,
		...(secsToIso(sub.trial_end)
			? { trialEndsAt: secsToIso(sub.trial_end) as IsoDateTime }
			: {}),
		currentPeriodStart:
			(secsToIso(sub.current_period_start) as IsoDateTime) ?? now,
		currentPeriodEnd: (secsToIso(sub.current_period_end) as IsoDateTime) ?? now,
		cancelAtPeriodEnd: sub.cancel_at_period_end,
		...(secsToIso(sub.canceled_at)
			? { canceledAt: secsToIso(sub.canceled_at) as IsoDateTime }
			: {}),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};

	await subsStore(ctx).put(record.id, record);
	return record;
}

export async function upsertInvoiceFromStripe(
	ctx: PluginContext,
	inv: StripeInvoice,
): Promise<SubscriptionInvoice | null> {
	if (!inv.subscription) return null;
	const sub = await findSubscription(ctx, inv.subscription);
	if (!sub) {
		ctx.log.warn("Invoice for unknown subscription", {
			invoiceId: inv.id,
			subscriptionId: inv.subscription,
		});
		return null;
	}

	// dedup on stripeInvoiceId unique index
	const existingRes = await invoiceStore(ctx).query({
		where: { stripeInvoiceId: inv.id },
		limit: 1,
	});
	const existing = existingRes.items[0];
	const id = existing?.id ?? randomId();

	const record: SubscriptionInvoice = {
		id,
		stripeInvoiceId: inv.id,
		subscriptionId: sub.id,
		amount: money(inv.currency.toUpperCase(), inv.amount_paid || inv.amount_due),
		status: inv.status,
		...(inv.status === "paid" ? { paidAt: new Date().toISOString() } : {}),
		attemptCount: inv.attempt_count ?? 0,
		createdAt:
			(existing?.data as SubscriptionInvoice | undefined)?.createdAt ??
			new Date().toISOString(),
	};
	await invoiceStore(ctx).put(id, record);

	if (inv.status === "paid" && inv.period_start && inv.period_end) {
		await subsStore(ctx).put(sub.id, {
			...sub,
			currentPeriodStart: new Date(inv.period_start * 1000).toISOString(),
			currentPeriodEnd: new Date(inv.period_end * 1000).toISOString(),
			status: "active",
			updatedAt: new Date().toISOString(),
		});
	}

	return record;
}

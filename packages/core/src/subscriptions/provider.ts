/**
 * Provider-neutral subscription storage.
 *
 * Stripe subscriptions still go through `create.ts` and `lifecycle.ts`; this
 * module is the additive path for providers that manage billing themselves
 * (Flutterwave Payment Plans). It reuses the existing `Subscription` and
 * `SubscriptionInvoice` collections and their unique indexes, keyed on the
 * provider's subscription/plan id.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { money } from "../money";
import type {
	CurrencyCode,
	IsoDateTime,
	Subscription,
	SubscriptionInvoice,
	SubscriptionStatus,
} from "../types";
import { randomId } from "../util/ids";

type SubsStore = StorageCollection<Subscription>;
type InvoiceStore = StorageCollection<SubscriptionInvoice>;

export function providerSubsStore(ctx: PluginContext): SubsStore {
	return (ctx.storage as unknown as { subscriptions: SubsStore }).subscriptions;
}

function invoiceStore(ctx: PluginContext): InvoiceStore {
	return (ctx.storage as unknown as { subscription_invoices: InvoiceStore })
		.subscription_invoices;
}

/** Add a billing interval to an ISO date, clamping month-end. */
export function addSubscriptionInterval(
	start: IsoDateTime,
	interval: Subscription["interval"],
	count: number,
): IsoDateTime {
	const date = new Date(start);
	const n = Math.max(1, Math.trunc(count));
	if (interval === "day") {
		date.setUTCDate(date.getUTCDate() + n);
		return date.toISOString();
	}
	if (interval === "week") {
		date.setUTCDate(date.getUTCDate() + n * 7);
		return date.toISOString();
	}
	const months = interval === "year" ? n * 12 : n;
	const day = date.getUTCDate();
	date.setUTCDate(1);
	date.setUTCMonth(date.getUTCMonth() + months);
	const lastDay = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
	).getUTCDate();
	date.setUTCDate(Math.min(day, lastDay));
	return date.toISOString();
}

export async function findProviderSubscription(
	ctx: PluginContext,
	providerId: string,
	providerSubscriptionId: string,
): Promise<Subscription | null> {
	const result = await providerSubsStore(ctx).query({
		where: { stripeSubscriptionId: providerSubscriptionId },
		limit: 1,
	});
	const row = result.items[0];
	if (!row) return null;
	const sub = { ...(row.data as Subscription), id: row.id };
	// Rows written before `providerId` existed are Stripe rows.
	if ((sub.providerId ?? "stripe") !== providerId) return null;
	return sub;
}

export interface UpsertProviderSubscriptionInput {
	providerId: string;
	providerSubscriptionId: string;
	customerId: string;
	productId: string;
	variantId?: string;
	status: SubscriptionStatus;
	currency: CurrencyCode;
	/** Integer minor units. */
	unitAmount: number;
	quantity: number;
	interval: Subscription["interval"];
	intervalCount: number;
	currentPeriodStart?: IsoDateTime;
	currentPeriodEnd?: IsoDateTime;
	trialEndsAt?: IsoDateTime;
	cancelAtPeriodEnd?: boolean;
	canceledAt?: IsoDateTime;
}

export async function upsertProviderSubscription(
	ctx: PluginContext,
	input: UpsertProviderSubscriptionInput,
): Promise<Subscription> {
	const existing = await findProviderSubscription(
		ctx,
		input.providerId,
		input.providerSubscriptionId,
	);
	const now = new Date().toISOString();
	const currentPeriodStart = input.currentPeriodStart ?? existing?.currentPeriodStart ?? now;
	const currentPeriodEnd =
		input.currentPeriodEnd ??
		existing?.currentPeriodEnd ??
		addSubscriptionInterval(currentPeriodStart, input.interval, input.intervalCount);

	const record: Subscription = {
		id: existing?.id ?? randomId(),
		stripeSubscriptionId: input.providerSubscriptionId,
		providerId: input.providerId,
		customerId: input.customerId,
		productId: input.productId,
		...(input.variantId ? { variantId: input.variantId } : {}),
		status: input.status,
		currency: input.currency,
		unitAmount: money(input.currency, input.unitAmount),
		quantity: input.quantity,
		interval: input.interval,
		intervalCount: input.intervalCount,
		...(input.trialEndsAt ? { trialEndsAt: input.trialEndsAt } : {}),
		currentPeriodStart,
		currentPeriodEnd,
		cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? existing?.cancelAtPeriodEnd ?? false,
		...(input.canceledAt ? { canceledAt: input.canceledAt } : {}),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	await providerSubsStore(ctx).put(record.id, record);
	return record;
}

export interface RecordProviderInvoiceInput {
	subscription: Subscription;
	providerId: string;
	providerInvoiceId: string;
	/** Integer minor units. */
	amount: number;
	currency: CurrencyCode;
	status?: SubscriptionInvoice["status"];
	paidAt?: IsoDateTime;
	attemptCount?: number;
	/** When paid, the new billing period. */
	periodStart?: IsoDateTime;
	periodEnd?: IsoDateTime;
}

export async function recordProviderSubscriptionInvoice(
	ctx: PluginContext,
	input: RecordProviderInvoiceInput,
): Promise<SubscriptionInvoice> {
	const existingResult = await invoiceStore(ctx).query({
		where: { stripeInvoiceId: input.providerInvoiceId },
		limit: 1,
	});
	const existing = existingResult.items[0];
	const id = existing?.id ?? randomId();
	const status = input.status ?? "paid";
	const now = new Date().toISOString();

	const invoice: SubscriptionInvoice = {
		id,
		stripeInvoiceId: input.providerInvoiceId,
		providerId: input.providerId,
		subscriptionId: input.subscription.id,
		amount: money(input.currency, input.amount),
		status,
		...(status === "paid" ? { paidAt: input.paidAt ?? now } : {}),
		attemptCount: input.attemptCount ?? 0,
		createdAt: (existing?.data as SubscriptionInvoice | undefined)?.createdAt ?? now,
	};
	await invoiceStore(ctx).put(id, invoice);

	if (status === "paid") {
		const periodStart = input.periodStart ?? input.subscription.currentPeriodStart;
		const periodEnd =
			input.periodEnd ??
			addSubscriptionInterval(
				periodStart,
				input.subscription.interval,
				input.subscription.intervalCount,
			);
		await providerSubsStore(ctx).put(input.subscription.id, {
			...input.subscription,
			status: "active",
			currentPeriodStart: periodStart,
			currentPeriodEnd: periodEnd,
			updatedAt: now,
		});
	}

	return invoice;
}

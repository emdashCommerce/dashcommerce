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
	return (ctx.storage as unknown as { subscription_invoices: InvoiceStore }).subscription_invoices;
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
	const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
	date.setUTCDate(Math.min(day, lastDay));
	return date.toISOString();
}

function providerStorageKey(providerId: string, providerSubscriptionId: string): string {
	return `${providerId}:${providerSubscriptionId}`;
}

export async function findProviderSubscription(
	ctx: PluginContext,
	providerId: string,
	providerSubscriptionId: string,
): Promise<Subscription | null> {
	const result = await providerSubsStore(ctx).query({
		where: { stripeSubscriptionId: providerStorageKey(providerId, providerSubscriptionId) },
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
		stripeSubscriptionId: providerStorageKey(input.providerId, input.providerSubscriptionId),
		providerId: input.providerId,
		providerSubscriptionId: input.providerSubscriptionId,
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
	const storageKey = `${input.providerId}:${input.providerInvoiceId}`;
	const existingResult = await invoiceStore(ctx).query({
		where: { stripeInvoiceId: storageKey },
		limit: 1,
	});
	const existing = existingResult.items[0];
	const existingInvoice = existing?.data as SubscriptionInvoice | undefined;
	const status = input.status ?? "paid";
	if (existingInvoice?.status === "paid" && status === "paid") {
		await applyProviderInvoicePeriod(ctx, existingInvoice);
		return { ...existingInvoice, id: existing?.id ?? existingInvoice.id };
	}
	const id = existing?.id ?? randomId();
	const now = new Date().toISOString();
	const periodStart =
		status === "paid" ? (input.periodStart ?? input.subscription.currentPeriodStart) : undefined;
	const periodEnd = periodStart
		? (input.periodEnd ??
			addSubscriptionInterval(
				periodStart,
				input.subscription.interval,
				input.subscription.intervalCount,
			))
		: undefined;

	const invoice: SubscriptionInvoice = {
		id,
		stripeInvoiceId: storageKey,
		providerId: input.providerId,
		providerInvoiceId: input.providerInvoiceId,
		subscriptionId: input.subscription.id,
		amount: money(input.currency, input.amount),
		status,
		...(status === "paid" ? { paidAt: input.paidAt ?? now, periodStart, periodEnd } : {}),
		attemptCount: input.attemptCount ?? 0,
		createdAt: existingInvoice?.createdAt ?? now,
	};
	// Freeze the period before updating the subscription so a replay can
	// finish applying it without extending a second time.
	await invoiceStore(ctx).put(id, invoice);
	await applyProviderInvoicePeriod(ctx, invoice);
	return invoice;
}

async function applyProviderInvoicePeriod(
	ctx: PluginContext,
	invoice: SubscriptionInvoice,
): Promise<void> {
	const { periodStart, periodEnd } = invoice;
	if (invoice.status !== "paid" || !periodStart || !periodEnd) return;
	const store = providerSubsStore(ctx);
	const subscription = await store.get(invoice.subscriptionId);
	if (!subscription) throw new Error(`Subscription ${invoice.subscriptionId} is missing`);
	if (Date.parse(subscription.currentPeriodEnd) >= Date.parse(periodEnd)) return;
	await store.put(invoice.subscriptionId, {
		...subscription,
		status: "active",
		currentPeriodStart: periodStart,
		currentPeriodEnd: periodEnd,
		updatedAt: new Date().toISOString(),
	});
}

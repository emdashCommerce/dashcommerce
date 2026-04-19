/**
 * Subscription renewal receipt — fires on Stripe `invoice.payment_succeeded`
 * for non-initial invoices (Stripe sets `billing_reason: "subscription_cycle"`
 * or `"subscription_update"`). The first invoice of a new subscription is
 * covered by the regular order receipt (checkout flow), so we intentionally
 * skip it here to avoid a duplicate on the very first paid period.
 */

import type { PluginContext } from "emdash";
import type { Customer, Subscription, SubscriptionInvoice } from "../types";
import { formatMoney, greet } from "./format";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

export interface ComposeRenewalInput {
	customer: Customer;
	subscription: Subscription;
	invoice: SubscriptionInvoice;
	siteName: string;
	portalUrl?: string;
}

export function composeSubscriptionRenewed(
	input: ComposeRenewalInput,
): ComposedEmail {
	const { customer, subscription, invoice, siteName, portalUrl } = input;

	const nextBillDate = subscription.currentPeriodEnd
		? new Date(subscription.currentPeriodEnd).toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			})
		: null;

	const subject = `Subscription renewed — ${formatMoney(invoice.amount)}`;

	const text = [
		greet(customer.firstName),
		"",
		`Your subscription renewed for ${formatMoney(invoice.amount)}. Thanks for sticking with us.`,
		nextBillDate ? `Next bill: ${nextBillDate}` : "",
		portalUrl ? `Manage subscription: ${portalUrl}` : "",
		"",
		`— ${siteName}`,
	]
		.filter((l) => l !== "")
		.join("\n");

	const body = `
	<h1>Subscription renewed</h1>
	<p>${escapeHtml(greet(customer.firstName))}</p>
	<p>Your subscription renewed for <strong>${escapeHtml(formatMoney(invoice.amount))}</strong>. Thanks for sticking with us.</p>
	${nextBillDate ? `<p class="muted">Next bill: ${escapeHtml(nextBillDate)}</p>` : ""}
	${portalUrl ? `<p style="margin-top:20px;"><a class="btn" href="${escapeHtml(portalUrl)}">Manage subscription</a></p>` : ""}`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `Renewed — ${formatMoney(invoice.amount)}`,
			body,
		}),
	};
}

/**
 * Low-level send wrapper. The caller is expected to have looked up
 * customer + subscription + invoice already.
 */
export async function sendSubscriptionRenewed(
	ctx: PluginContext,
	input: ComposeRenewalInput,
): Promise<void> {
	if (!ctx.email) return;
	try {
		const { subject, text, html } = composeSubscriptionRenewed(input);
		await ctx.email.send({ to: input.customer.email, subject, text, html });
	} catch (err) {
		ctx.log.warn("Failed to send subscription renewal email", {
			subscriptionId: input.subscription.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Dunning — subscription payment failed.
 *
 * Called from `subscriptions/dunning.ts::handleInvoicePaymentFailed`
 * after cooldown checks. Stripe handles the retry cadence; this message
 * is a courtesy heads-up so the customer updates their card.
 */

import type { Customer, Subscription, SubscriptionInvoice } from "../types";
import { formatMoney, greet } from "./format";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

export interface ComposeDunningInput {
	customer: Customer;
	subscription: Subscription;
	invoice: SubscriptionInvoice;
	siteName: string;
	portalUrl?: string;
}

export function composeDunning(input: ComposeDunningInput): ComposedEmail {
	const { customer, invoice, siteName, portalUrl } = input;

	const subject = "Action required: payment failed for your subscription";

	const text = [
		greet(customer.firstName),
		"",
		`We couldn't collect your most recent subscription payment of ${formatMoney(invoice.amount)}.`,
		"Stripe will retry automatically, but you can update your payment method any time.",
		"",
		`Attempt: ${invoice.attemptCount}`,
		portalUrl ? `Update payment method: ${portalUrl}` : "",
		"",
		`— ${siteName}`,
	]
		.filter((l) => l !== "")
		.join("\n");

	const body = `
	<h1>Payment failed — action needed</h1>
	<p>${escapeHtml(greet(customer.firstName))}</p>
	<p>We couldn't collect your most recent subscription payment of <strong>${escapeHtml(formatMoney(invoice.amount))}</strong>. Stripe will retry automatically, but the fastest fix is to update your card.</p>
	${portalUrl ? `<p style="margin-top:20px;"><a class="btn" href="${escapeHtml(portalUrl)}">Update payment method</a></p>` : ""}
	<p class="muted" style="margin-top:16px;">Retry attempt ${invoice.attemptCount}. If you've already updated your card, ignore this message.</p>`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `Payment failed — ${formatMoney(invoice.amount)}`,
			body,
		}),
	};
}

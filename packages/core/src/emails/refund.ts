/**
 * Refund receipt — fires on Stripe `charge.refunded` (see webhook
 * handler). One email per refund record.
 */

import type { PluginContext } from "emdash";
import type { Order, Refund } from "../types";
import { formatMoney, greet } from "./format";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

export interface ComposeRefundInput {
	order: Order;
	refund: Refund;
	siteName: string;
}

export function composeRefundReceipt(
	input: ComposeRefundInput,
): ComposedEmail {
	const { order, refund, siteName } = input;
	const subject = `Refund for order ${order.orderNumber}`;

	const text = [
		greet(order.billingAddress.firstName),
		"",
		`We've issued a refund of ${formatMoney(refund.amount)} against order ${order.orderNumber}.`,
		refund.reason ? `Reason: ${refund.reason}` : "",
		"",
		"Depending on your bank, funds typically arrive within 5–10 business days.",
		"",
		`— ${siteName}`,
	]
		.filter((l) => l !== "")
		.join("\n");

	const body = `
	<h1>Refund processed</h1>
	<p>${escapeHtml(greet(order.billingAddress.firstName))}</p>
	<p>We've issued a refund of <strong>${escapeHtml(formatMoney(refund.amount))}</strong> against order <strong>${escapeHtml(order.orderNumber)}</strong>.</p>
	${refund.reason ? `<p class="muted">Reason: ${escapeHtml(refund.reason)}</p>` : ""}
	<p>Depending on your bank, funds typically arrive within <strong>5–10 business days</strong>.</p>
	<p class="muted" style="margin-top:24px;">If you have questions about this refund, just reply to this email.</p>`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `Refund ${formatMoney(refund.amount)} for ${order.orderNumber}`,
			body,
		}),
	};
}

export async function sendRefundReceipt(
	ctx: PluginContext,
	order: Order,
	refund: Refund,
): Promise<void> {
	if (!ctx.email) return;
	try {
		const { subject, text, html } = composeRefundReceipt({
			order,
			refund,
			siteName: ctx.site.name,
		});
		await ctx.email.send({ to: order.customerEmail, subject, text, html });
	} catch (err) {
		ctx.log.warn("Failed to send refund receipt", {
			refundId: refund.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

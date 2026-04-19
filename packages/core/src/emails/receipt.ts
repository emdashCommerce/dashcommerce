/**
 * Order receipt — fires on successful payment (PaymentIntent succeeded
 * or Checkout Session completed, both handled in `routes/webhook.ts`).
 *
 * Minimal buyer-facing content: greeting, order number, line items,
 * totals table, a link back to the order (if we can construct one).
 * The order detail URL is host-site specific; we accept it as an
 * optional prop so the caller can wire `/thank-you/{orderDraftId}`
 * or `/account/orders/{orderNumber}`.
 */

import type { PluginContext } from "emdash";
import type { Order, OrderItem } from "../types";
import { formatMoney, greet } from "./format";
import { escapeHtml, renderHtml } from "./layout";

export interface ComposeReceiptInput {
	order: Order;
	items: OrderItem[];
	siteName: string;
	viewOrderUrl?: string;
}

export interface ComposedEmail {
	subject: string;
	text: string;
	html: string;
}

export function composeOrderReceipt(input: ComposeReceiptInput): ComposedEmail {
	const { order, items, siteName, viewOrderUrl } = input;

	const subject = `Your order ${order.orderNumber} from ${siteName}`;

	const textLines = [
		greet(order.billingAddress.firstName),
		"",
		"Thanks for your order. Payment received — we'll email again when it ships.",
		"",
		`Order: ${order.orderNumber}`,
		...items.map(
			(it) => `  ${it.quantity} × ${it.name} — ${formatMoney(it.total)}`,
		),
		"",
		`Subtotal: ${formatMoney(order.subtotal)}`,
	];
	if (order.discountTotal.amount > 0) {
		textLines.push(`Discount: -${formatMoney(order.discountTotal)}`);
	}
	if (order.shippingTotal.amount > 0) {
		textLines.push(`Shipping: ${formatMoney(order.shippingTotal)}`);
	}
	if (order.taxTotal.amount > 0) {
		textLines.push(`Tax: ${formatMoney(order.taxTotal)}`);
	}
	textLines.push(`Total: ${formatMoney(order.total)}`);
	if (viewOrderUrl) {
		textLines.push("", `View your order: ${viewOrderUrl}`);
	}
	textLines.push("", `— ${siteName}`);

	const itemsRows = items
		.map(
			(it) => `
				<tr>
					<td class="qty">${it.quantity}×</td>
					<td>${escapeHtml(it.name)}</td>
					<td class="amt">${escapeHtml(formatMoney(it.total))}</td>
				</tr>`,
		)
		.join("");

	const totalRows: string[] = [
		`<tr><td>Subtotal</td><td class="amt">${escapeHtml(formatMoney(order.subtotal))}</td></tr>`,
	];
	if (order.discountTotal.amount > 0) {
		totalRows.push(
			`<tr><td>Discount</td><td class="amt">−${escapeHtml(formatMoney(order.discountTotal))}</td></tr>`,
		);
	}
	if (order.shippingTotal.amount > 0) {
		totalRows.push(
			`<tr><td>Shipping</td><td class="amt">${escapeHtml(formatMoney(order.shippingTotal))}</td></tr>`,
		);
	}
	if (order.taxTotal.amount > 0) {
		totalRows.push(
			`<tr><td>Tax</td><td class="amt">${escapeHtml(formatMoney(order.taxTotal))}</td></tr>`,
		);
	}
	totalRows.push(
		`<tr class="grand"><td>Total</td><td class="amt">${escapeHtml(formatMoney(order.total))}</td></tr>`,
	);

	const button = viewOrderUrl
		? `<p style="margin-top:20px;"><a class="btn" href="${escapeHtml(viewOrderUrl)}">View order</a></p>`
		: "";

	const body = `
	<h1>Order ${escapeHtml(order.orderNumber)} confirmed</h1>
	<p>${escapeHtml(greet(order.billingAddress.firstName))}</p>
	<p>Thanks for your order. Your payment of <strong>${escapeHtml(formatMoney(order.total))}</strong> has been received — we'll email again when it ships.</p>

	<h2>Items</h2>
	<table class="lines" role="presentation">${itemsRows}</table>

	<h2>Summary</h2>
	<table class="totals" role="presentation">${totalRows.join("")}</table>
${button}
	<p class="muted" style="margin-top:24px;">Questions? Just reply to this email.</p>`;

	return {
		subject,
		text: textLines.join("\n"),
		html: renderHtml({
			siteName,
			preheader: `Order ${order.orderNumber} — ${formatMoney(order.total)}`,
			body,
		}),
	};
}

export async function sendOrderReceipt(
	ctx: PluginContext,
	order: Order,
	items: OrderItem[],
	viewOrderUrl?: string,
): Promise<void> {
	if (!ctx.email) {
		ctx.log.debug("No email provider — skipping order receipt", {
			orderId: order.id,
		});
		return;
	}
	try {
		const { subject, text, html } = composeOrderReceipt({
			order,
			items,
			siteName: ctx.site.name,
			...(viewOrderUrl ? { viewOrderUrl } : {}),
		});
		await ctx.email.send({ to: order.customerEmail, subject, text, html });
	} catch (err) {
		ctx.log.warn("Failed to send order receipt", {
			orderId: order.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

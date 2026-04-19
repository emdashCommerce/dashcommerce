/**
 * Abandoned-cart nudge — fires from the hourly cron job in
 * `abandoned-cart/recover.ts`. Composes only; sending and state-flip
 * still live with the cron for single-responsibility.
 */

import type { CartState } from "../types";
import { formatMoney } from "./format";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

export interface ComposeAbandonedCartInput {
	cart: CartState;
	restoreUrl: string;
	siteName: string;
}

export function composeAbandonedCart(
	input: ComposeAbandonedCartInput,
): ComposedEmail {
	const { cart, restoreUrl, siteName } = input;
	const itemCount = cart.items.reduce((s, it) => s + it.quantity, 0);

	const subject = `You left ${itemCount} item${itemCount === 1 ? "" : "s"} in your cart at ${siteName}`;

	const textLines = [
		"Hi,",
		"",
		`Looks like you left ${itemCount} item${itemCount === 1 ? "" : "s"} in your cart at ${siteName}:`,
		...cart.items.map((it) => `  • ${it.quantity} × ${it.title}`),
		"",
		`Cart total: ${formatMoney(cart.total)}`,
		"",
		`Jump back in: ${restoreUrl}`,
		"",
		"The link restores your cart with one click — no login needed.",
		"",
		`— ${siteName}`,
	];

	const itemRows = cart.items
		.map(
			(it) => `
				<tr>
					<td class="qty">${it.quantity}×</td>
					<td>${escapeHtml(it.title)}</td>
					<td class="amt">${escapeHtml(formatMoney(it.lineSubtotal))}</td>
				</tr>`,
		)
		.join("");

	const body = `
	<h1>Still thinking it over?</h1>
	<p>Looks like you left ${itemCount} item${itemCount === 1 ? "" : "s"} in your cart at <strong>${escapeHtml(siteName)}</strong>.</p>

	<table class="lines" role="presentation">${itemRows}</table>

	<table class="totals" role="presentation">
		<tr class="grand"><td>Total</td><td class="amt">${escapeHtml(formatMoney(cart.total))}</td></tr>
	</table>

	<p style="margin-top:20px;">
		<a class="btn" href="${escapeHtml(restoreUrl)}">Resume checkout</a>
	</p>
	<p class="muted" style="margin-top:12px;">One click restores your cart — no login needed.</p>`;

	return {
		subject,
		text: textLines.join("\n"),
		html: renderHtml({
			siteName,
			preheader: `Your cart total: ${formatMoney(cart.total)}`,
			body,
		}),
	};
}

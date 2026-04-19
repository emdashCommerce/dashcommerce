/**
 * Post-fulfilment review request.
 *
 * Fires when an order transitions to `completed` (typically the
 * merchant clicking "Mark fulfilled" after ship-out). Invited to leave
 * a review for each physical product in the order. We skip digital-only
 * carts — the "how did it arrive?" framing doesn't apply.
 *
 * Rate-limited to one request per order via a KV marker, so duplicate
 * fulfilment status flips don't spam the customer.
 */

import type { PluginContext } from "emdash";
import type { Order, OrderItem } from "../types";
import { greet } from "./format";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

export interface ComposeReviewRequestInput {
	order: Order;
	items: OrderItem[];
	siteName: string;
	/** URL to the first/primary product; the CTA button points here. */
	reviewCtaUrl?: string;
}

export function composeReviewRequest(
	input: ComposeReviewRequestInput,
): ComposedEmail {
	const { order, items, siteName, reviewCtaUrl } = input;

	const physicalItems = items.filter((it) => !it.isDigital);
	const names = physicalItems.map((it) => it.name);

	const subject = `How was your order from ${siteName}?`;

	const text = [
		greet(order.billingAddress.firstName),
		"",
		"Thanks again for your recent order. If you have a minute, we'd love to hear what you thought.",
		"",
		...names.map((n) => `  • ${n}`),
		"",
		reviewCtaUrl ? `Leave a review: ${reviewCtaUrl}` : "",
		"",
		"Every review helps other shoppers decide with confidence.",
		"",
		`— ${siteName}`,
	]
		.filter((l) => l !== "")
		.join("\n");

	const listHtml = physicalItems
		.map((it) => `<li>${escapeHtml(it.name)}</li>`)
		.join("");

	const body = `
	<h1>How did we do?</h1>
	<p>${escapeHtml(greet(order.billingAddress.firstName))}</p>
	<p>Thanks again for your recent order. If you have a minute, we'd love to hear your thoughts.</p>
	<ul style="margin:12px 0 18px 20px; padding:0; color:#3f3f46; font-size:14px; line-height:1.6;">${listHtml}</ul>
	${reviewCtaUrl ? `<p><a class="btn" href="${escapeHtml(reviewCtaUrl)}">Leave a review</a></p>` : ""}
	<p class="muted" style="margin-top:16px;">Every review helps other shoppers decide with confidence.</p>`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `Share your experience with ${siteName}`,
			body,
		}),
	};
}

const SENT_KEY = (orderId: string) => `state:reviewRequestSentAt:${orderId}`;

/**
 * Send once per order. Looks up a product URL to point the CTA at if
 * the caller can provide a slug→URL resolver (e.g. `/product/${slug}`).
 */
export async function sendReviewRequest(
	ctx: PluginContext,
	order: Order,
	items: OrderItem[],
	resolveProductUrl?: (item: OrderItem) => string | undefined,
): Promise<void> {
	if (!ctx.email) return;
	if (!order.customerEmail) return;

	const physical = items.filter((it) => !it.isDigital);
	if (physical.length === 0) return;

	const already = await ctx.kv.get<string>(SENT_KEY(order.id));
	if (already) return;

	const firstPhysical = physical[0];
	const reviewCtaUrl = firstPhysical ? resolveProductUrl?.(firstPhysical) : undefined;

	try {
		const { subject, text, html } = composeReviewRequest({
			order,
			items: physical,
			siteName: ctx.site.name,
			...(reviewCtaUrl ? { reviewCtaUrl } : {}),
		});
		await ctx.email.send({ to: order.customerEmail, subject, text, html });
		await ctx.kv.set(SENT_KEY(order.id), new Date().toISOString());
	} catch (err) {
		ctx.log.warn("Failed to send review request email", {
			orderId: order.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

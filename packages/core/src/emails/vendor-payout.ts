/**
 * Vendor payout notification — fires on Stripe `payout.paid` for a
 * connected account. Sent only for the first persisted record per
 * `stripePayoutId` (the webhook can fire multiple times on status
 * updates; we pin the send to the KV marker to avoid duplicate emails).
 */

import type { PluginContext } from "emdash";
import type { Vendor, VendorPayout } from "../types";
import { formatMoney } from "./format";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

export interface ComposeVendorPayoutInput {
	vendor: Vendor;
	payout: VendorPayout;
	siteName: string;
	dashboardUrl?: string;
}

export function composeVendorPayout(
	input: ComposeVendorPayoutInput,
): ComposedEmail {
	const { vendor, payout, siteName, dashboardUrl } = input;
	const subject = `Payout sent — ${formatMoney(payout.amount)}`;

	const arrival = payout.arrivalDate
		? new Date(payout.arrivalDate).toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			})
		: null;

	const text = [
		`Hi ${vendor.name || "there"},`,
		"",
		`A payout of ${formatMoney(payout.amount)} has been sent to your connected bank account.`,
		arrival ? `Expected arrival: ${arrival}` : "",
		dashboardUrl ? `Full history: ${dashboardUrl}` : "",
		"",
		`— ${siteName}`,
	]
		.filter((l) => l !== "")
		.join("\n");

	const body = `
	<h1>Payout sent</h1>
	<p>Hi ${escapeHtml(vendor.name || "there")},</p>
	<p>A payout of <strong>${escapeHtml(formatMoney(payout.amount))}</strong> has been sent to your connected bank account.</p>
	${arrival ? `<p class="muted">Expected arrival: <strong>${escapeHtml(arrival)}</strong></p>` : ""}
	${dashboardUrl ? `<p style="margin-top:20px;"><a class="btn" href="${escapeHtml(dashboardUrl)}">Open seller dashboard</a></p>` : ""}`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `Payout ${formatMoney(payout.amount)}`,
			body,
		}),
	};
}

const SENT_KEY = (stripePayoutId: string) =>
	`state:vendorPayoutEmailSentAt:${stripePayoutId}`;

export async function sendVendorPayout(
	ctx: PluginContext,
	vendor: Vendor,
	payout: VendorPayout,
	dashboardUrl?: string,
): Promise<void> {
	if (!ctx.email) return;
	if (!vendor.email) return;
	if (payout.status !== "paid") return;
	const already = await ctx.kv.get<string>(SENT_KEY(payout.stripePayoutId));
	if (already) return;
	try {
		const { subject, text, html } = composeVendorPayout({
			vendor,
			payout,
			siteName: ctx.site.name,
			...(dashboardUrl ? { dashboardUrl } : {}),
		});
		await ctx.email.send({ to: vendor.email, subject, text, html });
		await ctx.kv.set(SENT_KEY(payout.stripePayoutId), new Date().toISOString());
	} catch (err) {
		ctx.log.warn("Failed to send vendor payout email", {
			vendorId: vendor.id,
			payoutId: payout.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

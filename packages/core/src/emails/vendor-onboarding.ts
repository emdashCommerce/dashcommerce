/**
 * Vendor onboarding notifications.
 *
 *   - `vendor-invite`: emailed when the merchant starts onboarding for a
 *     vendor. Contains the short-TTL Stripe AccountLink.
 *   - `vendor-onboarded`: emailed on the first `account.updated` webhook
 *     where `charges_enabled` flips true (the vendor has finished KYC
 *     and can receive payouts).
 *
 * Both are composer-only; senders are wired from `vendors/onboarding.ts`
 * and `routes/webhook.ts` respectively.
 */

import type { PluginContext } from "emdash";
import type { Vendor } from "../types";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

export interface ComposeVendorInviteInput {
	vendor: Vendor;
	onboardingUrl: string;
	siteName: string;
}

export function composeVendorInvite(
	input: ComposeVendorInviteInput,
): ComposedEmail {
	const { vendor, onboardingUrl, siteName } = input;
	const subject = `Finish setting up your ${siteName} seller account`;

	const text = [
		`Hi ${vendor.name || "there"},`,
		"",
		`You've been invited to sell on ${siteName}. To accept payouts we need a few`,
		"details from Stripe (their standard KYC form — typically under 5 minutes).",
		"",
		`Complete onboarding: ${onboardingUrl}`,
		"",
		"The link expires after a few minutes for security; request a new one if it has.",
		"",
		`— ${siteName}`,
	].join("\n");

	const body = `
	<h1>Finish setting up your seller account</h1>
	<p>Hi ${escapeHtml(vendor.name || "there")},</p>
	<p>You've been invited to sell on <strong>${escapeHtml(siteName)}</strong>. To accept payouts we need a few details from Stripe (their standard KYC form — typically under 5 minutes).</p>
	<p style="margin-top:20px;"><a class="btn" href="${escapeHtml(onboardingUrl)}">Complete onboarding</a></p>
	<p class="muted" style="margin-top:16px;">The link expires after a few minutes for security. If it has, request a new one from the merchant.</p>`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `Complete your ${siteName} seller onboarding`,
			body,
		}),
	};
}

export async function sendVendorInvite(
	ctx: PluginContext,
	vendor: Vendor,
	onboardingUrl: string,
): Promise<void> {
	if (!ctx.email) return;
	try {
		const { subject, text, html } = composeVendorInvite({
			vendor,
			onboardingUrl,
			siteName: ctx.site.name,
		});
		await ctx.email.send({ to: vendor.email, subject, text, html });
	} catch (err) {
		ctx.log.warn("Failed to send vendor invite email", {
			vendorId: vendor.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export interface ComposeVendorActivatedInput {
	vendor: Vendor;
	siteName: string;
	dashboardUrl?: string;
}

export function composeVendorActivated(
	input: ComposeVendorActivatedInput,
): ComposedEmail {
	const { vendor, siteName, dashboardUrl } = input;
	const subject = `You're approved — welcome to ${siteName}`;

	const text = [
		`Hi ${vendor.name || "there"},`,
		"",
		`Your seller account is verified and active on ${siteName}.`,
		"You can now receive orders and payouts to your connected bank.",
		"",
		dashboardUrl ? `Open your seller dashboard: ${dashboardUrl}` : "",
		"",
		`— ${siteName}`,
	]
		.filter((l) => l !== "")
		.join("\n");

	const body = `
	<h1>You're approved</h1>
	<p>Hi ${escapeHtml(vendor.name || "there")},</p>
	<p>Your seller account is verified and active on <strong>${escapeHtml(siteName)}</strong>. You can now receive orders and payouts to your connected bank.</p>
	${dashboardUrl ? `<p style="margin-top:20px;"><a class="btn" href="${escapeHtml(dashboardUrl)}">Open seller dashboard</a></p>` : ""}`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `Your seller account is active on ${siteName}`,
			body,
		}),
	};
}

const ACTIVATED_KEY = (vendorId: string) =>
	`state:vendorActivatedEmailSentAt:${vendorId}`;

/**
 * Send activation email once per vendor. Intended to be called from the
 * `account.updated` webhook path when we detect `chargesEnabled` flipped
 * from false → true.
 */
export async function sendVendorActivated(
	ctx: PluginContext,
	vendor: Vendor,
	dashboardUrl?: string,
): Promise<void> {
	if (!ctx.email) return;
	if (!vendor.email) return;
	const already = await ctx.kv.get<string>(ACTIVATED_KEY(vendor.id));
	if (already) return;
	try {
		const { subject, text, html } = composeVendorActivated({
			vendor,
			siteName: ctx.site.name,
			...(dashboardUrl ? { dashboardUrl } : {}),
		});
		await ctx.email.send({ to: vendor.email, subject, text, html });
		await ctx.kv.set(ACTIVATED_KEY(vendor.id), new Date().toISOString());
	} catch (err) {
		ctx.log.warn("Failed to send vendor activated email", {
			vendorId: vendor.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

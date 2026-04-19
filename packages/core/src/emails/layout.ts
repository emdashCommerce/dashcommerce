/**
 * Shared HTML wrapper for every transactional email.
 *
 * Deliberately plain: table-based layout, inlined styles, system fonts.
 * No webfont loads, no external assets. The goal is bulletproof rendering
 * in Gmail, Apple Mail, Outlook, and every webmail in between — not visual
 * polish. A merchant who wants their own skin can swap in `renderHtml`
 * wholesale via a future `settings:emailTemplate` override (not scoped
 * here).
 *
 * Inputs are plain strings; callers are responsible for passing in
 * already-escaped / sanitized values. We escape everything we render from
 * untrusted sources (customer name, product titles, etc.) via `escapeHtml`.
 */

export function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export interface LayoutOptions {
	siteName: string;
	preheader?: string;
	/** Body HTML — the caller must produce valid, already-escaped markup. */
	body: string;
	/** Optional rendered footer; falls back to a generic auto-send notice. */
	footer?: string;
}

/**
 * Render the outer HTML shell. Designed for narrow (~600px) width with
 * generous padding and no outer background color — matches the look of
 * most SaaS transactional emails (Stripe, Linear, GitHub).
 */
export function renderHtml({
	siteName,
	preheader,
	body,
	footer,
}: LayoutOptions): string {
	const safeSiteName = escapeHtml(siteName);
	const safePreheader = preheader ? escapeHtml(preheader) : "";
	const safeFooter = footer
		? footer
		: `This is an automated message from ${safeSiteName}.`;
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${safeSiteName}</title>
<style>
	body { margin: 0; padding: 0; background: #f6f6f7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; }
	.wrap { max-width: 600px; margin: 0 auto; padding: 24px 16px; }
	.card { background: #ffffff; border: 1px solid #e4e4e7; border-radius: 8px; padding: 28px; }
	h1 { font-size: 20px; margin: 0 0 16px; font-weight: 600; }
	h2 { font-size: 15px; margin: 24px 0 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #52525b; }
	p { font-size: 15px; line-height: 1.55; margin: 0 0 12px; }
	a { color: #2563eb; }
	.muted { color: #71717a; font-size: 13px; }
	.brand { font-size: 13px; color: #52525b; margin-bottom: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
	.btn { display: inline-block; padding: 10px 16px; background: #111827; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px; }
	table.lines { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
	table.lines td { padding: 6px 0; border-bottom: 1px solid #f1f1f3; font-size: 14px; vertical-align: top; }
	table.lines td.qty { color: #71717a; width: 48px; white-space: nowrap; }
	table.lines td.amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
	table.totals { width: 100%; margin: 8px 0 4px; border-collapse: collapse; }
	table.totals td { padding: 4px 0; font-size: 14px; }
	table.totals td.amt { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
	table.totals tr.grand td { border-top: 1px solid #e4e4e7; padding-top: 10px; margin-top: 4px; font-weight: 600; font-size: 16px; }
	.footer { text-align: center; font-size: 12px; color: #a1a1aa; padding: 16px 8px 0; }
	.preheader { display: none !important; visibility: hidden; mso-hide: all; font-size: 1px; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; }
</style>
</head>
<body>
${safePreheader ? `<span class="preheader">${safePreheader}</span>` : ""}
<div class="wrap">
	<div class="brand">${safeSiteName}</div>
	<div class="card">
${body}
	</div>
	<div class="footer">${safeFooter}</div>
</div>
</body>
</html>`;
}

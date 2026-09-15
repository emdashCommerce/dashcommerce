/**
 * Site URL helpers.
 *
 * Production deployments behind reverse proxies (Railway, nginx, etc.) may
 * have stale database options (e.g. `emdash:site_url`) pointing to
 * localhost or internal routing addresses. These helpers ensure we always
 * use the public site URL from the environment configuration.
 */

import type { PluginContext } from "emdash";

/**
 * Get the public site URL, never localhost in production.
 *
 * Prefers `ctx.site.url` (from SITE_URL env var via Astro config) over
 * any stale database options. Strips trailing slashes for clean URL
 * construction.
 *
 * If ctx.site.url starts with localhost in production, this is a
 * configuration error and should be fixed by setting SITE_URL.
 *
 * @throws Error if ctx.site.url is missing or invalid
 */
export function getPublicSiteUrl(ctx: PluginContext): string {
	const siteUrl = ctx.site?.url;
	if (!siteUrl) {
		throw new Error(
			"ctx.site.url is not configured. Set SITE_URL environment variable.",
		);
	}

	// Normalize: strip trailing slash
	const normalized = siteUrl.replace(/\/$/, "");

	// Warn if localhost is detected - this suggests SITE_URL wasn't set
	if (
		normalized.includes("localhost") ||
		normalized.includes("127.0.0.1") ||
		normalized.includes("0.0.0.0")
	) {
		ctx.log.warn("Site URL is localhost - set SITE_URL for production", {
			siteUrl: normalized,
		});
	}

	return normalized;
}

/**
 * Returns true if the site URL appears to be a production deployment
 * (not localhost, not common dev ports).
 */
export function isProductionSiteUrl(ctx: PluginContext): boolean {
	try {
		const url = getPublicSiteUrl(ctx);
		return (
			!url.includes("localhost") &&
			!url.includes("127.0.0.1") &&
			!url.includes("0.0.0.0") &&
			!url.includes(":4321") && // Astro default dev port
			!url.includes(":3000") && // Common dev port
			!url.includes(":8080") // Common container port
		);
	} catch {
		return false;
	}
}

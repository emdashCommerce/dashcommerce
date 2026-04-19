/**
 * Site meta helper — the single source of truth for site-wide identity
 * (title, tagline, logo, social, SEO) across every layout/component.
 *
 * Why this exists: the EmDash themes guide
 * (https://docs.emdashcms.com/themes/creating-themes/) is explicit that a
 * theme must not hard-code its site title / tagline / navigation — it must
 * read them from the CMS via `getSiteSettings()`. Before this helper the
 * starter had literal strings ("The Edit", "Curated goods…") baked into
 * `Shop.astro`, `Header.astro` and `Footer.astro`, which meant an editor
 * installing the starter had no way to rebrand it from the admin UI.
 *
 * We wrap `getSiteSettings()` so templates get:
 *   - a stable, fully-populated shape (no `undefined` splatter in JSX)
 *   - sensible fallbacks that match the seed
 *   - the pinterest URL resurrected from `site_text.main` (SiteSettings
 *     has no typed pinterest field, so we keep that one in the singleton)
 */
import { getEmDashEntry, getSiteSettings } from "emdash";

export interface ResolvedSiteMeta {
	/** Site title — shown in `<title>`, og:site_name, logo text fallback. */
	title: string;
	/** Tagline — used as the default meta description / og:description. */
	tagline: string;
	/** Logo image reference. `null` when the admin hasn't uploaded one. */
	logo: { url?: string; alt?: string } | null;
	/** Favicon image reference. `null` when the admin hasn't uploaded one. */
	favicon: { url?: string; alt?: string } | null;
	/** Absolute site URL (used for canonical / sitemap). */
	url: string | null;
	/** Posts-per-page setting. Default 10 matches EmDash's built-in default. */
	postsPerPage: number;
	/** Social links. Only URLs that are actually set come through. */
	social: {
		instagram?: string;
		twitter?: string;
		facebook?: string;
		linkedin?: string;
		youtube?: string;
		github?: string;
		/** Pinterest isn't in SiteSettings — we keep it in site_text.main. */
		pinterest?: string;
	};
	/** SEO settings. */
	seo: {
		/** Separator between page title and site title. Default " — ". */
		titleSeparator: string;
	};
}

/**
 * Resolve the site meta.
 *
 * Deliberately NOT memoised at module scope: Astro reuses module instances
 * across requests during SSR, so a module-level cache would return the
 * values that were live when the server started — edits in the admin UI
 * wouldn't show up until restart. The underlying `getSiteSettings()`
 * already hits SQLite which is effectively instant, so we pay the lookup
 * every render to stay correct.
 */
export async function getSiteMeta(): Promise<ResolvedSiteMeta> {
	const settings = await getSiteSettings();

	// Pinterest + any other channels EmDash's typed schema doesn't cover
	// still live on the `site_text.main` singleton. Read them lazily so
	// fresh installs (no site_text yet) don't blow up.
	let pinterest: string | undefined;
	try {
		const { entry: siteText } = await getEmDashEntry("site_text", "main");
		const data = (siteText?.data ?? {}) as Record<string, unknown>;
		const raw = String(data.social_pinterest ?? "").trim();
		if (raw) pinterest = raw;
	} catch {
		// site_text collection may not exist in some environments; ignore.
	}

	const social = settings.social ?? {};

	// SiteSettings types `logo`/`favicon` as plain MediaReference, but
	// getSiteSettings() resolves them at runtime and tacks a `url` on (see
	// node_modules/emdash/src/settings/index.ts::resolveMediaReference).
	// We cast to pick that up without leaking the emdash-internal shape.
	const logoRef = settings.logo as
		| { mediaId: string; alt?: string; url?: string }
		| undefined;
	const faviconRef = settings.favicon as
		| { mediaId: string; alt?: string; url?: string }
		| undefined;

	return {
		title: settings.title ?? "My Shop",
		tagline: settings.tagline ?? "",
		logo: logoRef?.mediaId
			? { url: logoRef.url, alt: logoRef.alt }
			: null,
		favicon: faviconRef?.mediaId
			? { url: faviconRef.url, alt: faviconRef.alt }
			: null,
		url: settings.url ?? null,
		postsPerPage: settings.postsPerPage ?? 10,
		social: {
			instagram: social.instagram?.trim() || undefined,
			twitter: social.twitter?.trim() || undefined,
			facebook: social.facebook?.trim() || undefined,
			linkedin: social.linkedin?.trim() || undefined,
			youtube: social.youtube?.trim() || undefined,
			github: social.github?.trim() || undefined,
			pinterest,
		},
		seo: {
			titleSeparator: settings.seo?.titleSeparator ?? " — ",
		},
	};
}

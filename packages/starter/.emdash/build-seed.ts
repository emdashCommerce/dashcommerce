/**
 * Build the seed file at packages/starter/.emdash/seed.json by merging
 * DashCommerce's products collection + taxonomies + 6 demo products
 * spanning every product type.
 *
 * The seed location (`.emdash/seed.json`) follows the convention documented
 * at https://docs.emdashcms.com/themes/creating-themes/. The matching
 * `.emdash/uploads/` directory holds any local media referenced via
 * `$media: { file: ... }` in this file.
 *
 * Run with: `bun .emdash/build-seed.ts` from the starter package.
 */

import { writeFileSync } from "node:fs";
import {
	DEMO_PRODUCTS,
	DEMO_PRODUCT_CATEGORY_TERMS,
	DEMO_PRODUCT_TAG_TERMS,
	type DemoProductEntry,
	defineProductsCollection,
	defineProductTaxonomies,
} from "@dashcommerce/core";

// Pull the shared demo catalog from @dashcommerce/core so the starter and the
// `dashcommerce-merge-seed --with-demo-catalog` CLI stay in sync.
const productCategoryTerms = DEMO_PRODUCT_CATEGORY_TERMS;
const productTagTerms = DEMO_PRODUCT_TAG_TERMS;

interface HeroSlideEntry {
	id: string;
	slug: string;
	status: "published" | "draft";
	data: Record<string, unknown>;
}

/**
 * Home-page hero slider. A standalone content collection (not a
 * DashCommerce-owned concept) so editors can add/remove/reorder slides
 * from the admin without touching the starter template.
 */
const heroSlidesCollection = {
	slug: "hero_slides",
	label: "Hero Slides",
	labelSingular: "Hero Slide",
	description: "Rotating banner shown at the top of the home page.",
	icon: "image",
	supports: ["drafts"],
	fields: [
		{
			slug: "eyebrow",
			label: "Eyebrow",
			type: "string",
			required: false,
			help: "Small label above the headline (e.g. 'New arrivals').",
		},
		{
			slug: "headline",
			label: "Headline",
			type: "text",
			required: true,
			help: "Main display text. Use line breaks for visual line wrapping.",
		},
		{
			slug: "subtitle",
			label: "Subtitle",
			type: "text",
			required: false,
			help: "Short supporting copy under the headline.",
		},
		{
			slug: "cta_label",
			label: "CTA label",
			type: "string",
			required: false,
			defaultValue: "Shop now",
		},
		{
			slug: "cta_href",
			label: "CTA link",
			type: "string",
			required: false,
			defaultValue: "/shop",
			help: "Relative or absolute URL the primary button navigates to.",
		},
		// ── Background: gradient / image / video ──
		// How the background is resolved at render time:
		//   1. If a Video URL is set → video wins.
		//   2. Else if a Background image is uploaded → image wins.
		//   3. Else → the Gradient / CSS field is used.
		// The `bg_type` select is effectively a hint; the template only
		// falls back to it when no media is present. Editors don't have
		// to remember to switch it — uploading an image just shows the
		// image, uploading nothing keeps the gradient.
		{
			slug: "bg_type",
			label: "Background type",
			type: "select",
			required: false,
			defaultValue: "gradient",
			widget: "dashcommerce:bg-type-select",
			options: [
				{ value: "gradient", label: "Gradient / CSS" },
				{ value: "image", label: "Image" },
				{ value: "video", label: "Video (MP4, YouTube, Vimeo)" },
			],
			help: "Switching this reveals only the fields you need. The storefront also auto-picks Video URL > Image > Gradient as a fallback, so uploading a richer medium 'just works' even if this stays on a simpler mode.",
		},
		{
			slug: "bg_css",
			label: "Gradient / CSS (fallback background)",
			type: "string",
			required: false,
			defaultValue: "radial-gradient(ellipse at 70% 50%, #1a1000 0%, #0b0b0b 70%)",
			help: "Used when no image or video is set. Any valid CSS background — paste a gradient, solid colour, or image() function. Also shows behind a video while it loads.",
		},
		{
			slug: "bg_image",
			label: "Background image",
			type: "image",
			required: false,
			help: "If set, takes precedence over the gradient. Recommended: 2400×1200, JPG/WebP. Leave empty to use the gradient.",
		},
		{
			slug: "bg_focal_point",
			label: "Image focal point",
			type: "string",
			required: false,
			defaultValue: "center",
			help: "Applies when a background image is set. CSS object-position (e.g. 'center', 'top right', '30% 60%').",
		},
		{
			slug: "bg_video_url",
			label: "Video URL (highest priority)",
			type: "string",
			required: false,
			help: "If set, overrides both the image and the gradient. Paste a direct MP4/WebM URL, a YouTube link, or a Vimeo link. Leave empty to use the image or gradient instead.",
		},
		{
			slug: "bg_video_poster",
			label: "Video poster (fallback image)",
			type: "image",
			required: false,
			help: "Shown while the video loads or on devices that block autoplay.",
		},
		{
			slug: "bg_overlay",
			label: "Overlay (over image/video)",
			type: "string",
			required: false,
			defaultValue: "linear-gradient(90deg, rgba(11,11,11,.78) 0%, rgba(11,11,11,.35) 100%)",
			help: "CSS background layered over image/video backgrounds to keep the text legible. Use e.g. 'rgba(0,0,0,.45)' for a flat dim, or a gradient for directional shading.",
		},
		{
			slug: "accent_css",
			label: "Accent bar",
			type: "string",
			required: false,
			defaultValue: "linear-gradient(90deg, #c8a46e, #8b6520)",
			help: "CSS background for the thin bar at the bottom of the slide.",
		},
		{
			slug: "sort_order",
			label: "Sort order",
			type: "integer",
			required: false,
			defaultValue: 0,
			help: "Slides display in ascending order. Lower numbers first.",
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Posts: editorial blog / journal
// ─────────────────────────────────────────────────────────────────────────────
//
// Standalone content collection for long-form editorial content: product
// stories, buying guides, behind-the-scenes. Storefront routes live under
// `/blog/*` so the homepage nav stays clean. `hasSeo: true` enables SEO
// metadata fields in the admin (title, description, og:image, etc).
//
const postsCollection = {
	slug: "posts",
	label: "Posts",
	labelSingular: "Post",
	description:
		"Editorial content — product stories, buying guides, and behind-the-scenes. Shown on the homepage 'From the journal' section and the /blog index.",
	icon: "file-text",
	supports: ["drafts", "revisions", "seo", "search"],
	urlPattern: "/blog/{slug}",
	hasSeo: true,
	fields: [
		{
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		},
		{
			slug: "excerpt",
			label: "Excerpt",
			type: "text",
			required: false,
			help: "Short summary shown on listing cards and meta descriptions. 140–180 chars.",
		},
		{
			slug: "cover_image",
			label: "Cover image",
			type: "image",
			required: false,
			help: "Hero image at the top of the article and the thumbnail on listing cards.",
		},
		{
			slug: "cover_gradient",
			label: "Cover fallback gradient",
			type: "string",
			required: false,
			defaultValue: "linear-gradient(135deg, #2d1800 0%, #0b0b0b 100%)",
			help: "Shown when no cover image is set. Any valid CSS background.",
		},
		{
			slug: "author_name",
			label: "Author name",
			type: "string",
			required: false,
			defaultValue: "The Edit",
			help: "Display byline. Leave blank to hide the author line.",
		},
		{
			slug: "published_date",
			label: "Published date",
			type: "datetime",
			required: false,
			help: "Override the auto publish time if you want a specific display date.",
		},
		{
			slug: "reading_minutes",
			label: "Reading time (minutes)",
			type: "integer",
			required: false,
			defaultValue: 4,
			help: "Estimated reading time shown next to the author line.",
		},
		{
			slug: "body",
			label: "Body",
			type: "portableText",
			required: false,
			help: "Rich article content — supports headings, paragraphs, lists, quotes, images, and embeds.",
		},
	],
};

// ── Post taxonomies ──────────────────────────────────────────────────────────
const postCategoryTerms: Array<{
	slug: string;
	label: string;
	description?: string;
}> = [
	{
		slug: "behind-the-scenes",
		label: "Behind the Scenes",
		description:
			"How products are made, sourced, or designed. Craft, process, and provenance stories.",
	},
	{
		slug: "product-stories",
		label: "Product Stories",
		description:
			"Deep dives on individual products — why they're in the edit, what makes them worth owning.",
	},
	{
		slug: "buying-guides",
		label: "Buying Guides",
		description:
			"Practical, gift-style roundups that help readers pick the right product for the job.",
	},
];

const postTaxonomy = {
	name: "post_category",
	label: "Post Categories",
	labelSingular: "Post Category",
	hierarchical: false,
	collections: ["posts"],
	terms: postCategoryTerms,
};

// ── Portable-Text helpers (small builder so seed data stays readable) ────────
//
// astro-portabletext expects sanity-style blocks with `_type`, `_key`, and a
// `children` array of spans. Building them by hand is verbose, so these
// helpers take plain strings and produce valid PT JSON.
//
let _ptKey = 0;
const ptKey = (prefix: string) => `${prefix}-${(_ptKey++).toString(36)}`;
function ptBlock(style: "normal" | "h2" | "h3" | "blockquote", text: string) {
	return {
		_type: "block",
		_key: ptKey("b"),
		style,
		markDefs: [],
		children: [{ _type: "span", _key: ptKey("s"), marks: [], text }],
	};
}
function ptList(style: "bullet" | "number", items: string[]) {
	return items.map((text) => ({
		_type: "block",
		_key: ptKey("li"),
		style: "normal",
		listItem: style,
		level: 1,
		markDefs: [],
		children: [{ _type: "span", _key: ptKey("s"), marks: [], text }],
	}));
}

// ── Demo posts ───────────────────────────────────────────────────────────────
interface DemoPost {
	id: string;
	slug: string;
	status: "published";
	data: Record<string, unknown>;
	taxonomies?: Record<string, string[]>;
}

const demoPosts: DemoPost[] = [
	{
		id: "post-craft-of-enamel",
		slug: "the-craft-of-enamel",
		status: "published",
		data: {
			title: "The Craft of Enamel: Behind Our Signature Mugs",
			excerpt:
				"Every enamel mug in The Edit is dipped and fired by hand. Here's what goes into one.",
			cover_gradient: "linear-gradient(135deg, #2d1800 0%, #0b0b0b 100%)",
			author_name: "Maren Osei",
			published_date: "2026-03-12T09:00:00.000Z",
			reading_minutes: 5,
			body: [
				ptBlock(
					"normal",
					"Enamelware sits at a strange intersection of the industrial and the handmade. At a glance, our signature mug looks like a mass-produced kitchen staple. Up close — once you know what to look for — every piece is unmistakably the work of a small team in a single workshop.",
				),
				ptBlock("h2", "From blank steel to finished piece"),
				ptBlock(
					"normal",
					"Each mug begins life as a pressed steel blank. The blanks are pickled to remove any mill scale, then dipped twice in a liquid enamel slurry. Between dips, they're hung on a rack to dry for at least four hours — rush it, and you get hairline cracks that show up only after firing.",
				),
				...ptList("bullet", [
					"Pressed steel blanks sourced from a Midlands fabricator",
					"Two-coat dipping (base + topcoat) to resist chipping",
					"Fired at 820°C for 180 seconds, then air-cooled",
					"Inspected for pinholes, glossed rims, and weight parity",
				]),
				ptBlock("h2", "Why we fire at 820°C"),
				ptBlock(
					"normal",
					"Most factory enamelware is fired hotter and faster to move product. At 820°C the coat fuses a touch more gently — it takes longer per piece, but the resulting surface is harder and the colour sits a little deeper.",
				),
				ptBlock(
					"blockquote",
					"The difference isn't visible from across the room. It's visible on the lip of the mug, in your hand, every morning for ten years.",
				),
				ptBlock(
					"normal",
					"We've had customers send us photos of our mugs still going strong after a decade of daily use. That's the point of enamel — it should outlast the kitchen you bought it for.",
				),
			],
		},
		taxonomies: { post_category: ["behind-the-scenes"] },
	},
	{
		id: "post-why-we-ship-monthly",
		slug: "why-we-ship-monthly-boxes",
		status: "published",
		data: {
			title: "Why We Ship Monthly Boxes Instead of Bigger Catalogues",
			excerpt:
				"Three years in, subscription boxes are still our favourite product. Here's why constraint beats abundance.",
			cover_gradient: "linear-gradient(135deg, #001a0a 0%, #0b0b0b 100%)",
			author_name: "Theo Park",
			published_date: "2026-03-04T09:00:00.000Z",
			reading_minutes: 6,
			body: [
				ptBlock(
					"normal",
					"When we launched the Monthly Box, the internal pitch was half-serious: 'make the smallest possible product with the largest possible meaning.' Three years and 14,000 boxes later, it's still our highest-NPS line.",
				),
				ptBlock("h2", "Constraint is the product"),
				ptBlock(
					"normal",
					"A monthly box forces us to pick four things we genuinely believe in. Not forty. Not four hundred. That's the feature — it filters out the noise on behalf of the customer, because we've done the filtering for them.",
				),
				ptBlock(
					"normal",
					"Our customers don't subscribe for the 12% discount. They subscribe because 'four good things a month' is a better editorial contract than 'an unlimited online shop.'",
				),
				ptBlock("h2", "How we plan a year ahead"),
				...ptList("number", [
					"February each year, we lock the theme for the next twelve months.",
					"Each month gets a lead item (~50% of the box value) and three supporting items.",
					"We try to ensure one digital good per quarter — it keeps the ratio balanced.",
					"Final composition signs off ten weeks before the ship date.",
				]),
				ptBlock(
					"blockquote",
					"The best subscription products feel like letters from a friend with better taste than you. Ours tries to read that way.",
				),
			],
		},
		taxonomies: { post_category: ["behind-the-scenes"] },
	},
	{
		id: "post-in-defense-of-the-logo-tee",
		slug: "in-defense-of-the-logo-tee",
		status: "published",
		data: {
			title: "In Defence of the Logo Tee",
			excerpt:
				"The plain T-shirt is having a moment again. We make the case for putting a small mark back on it.",
			cover_gradient: "linear-gradient(135deg, #1a0f00 0%, #0b0b0b 100%)",
			author_name: "Priya Nair",
			published_date: "2026-02-22T09:00:00.000Z",
			reading_minutes: 4,
			body: [
				ptBlock(
					"normal",
					"Fashion has spent the last decade convinced the future of the T-shirt is quiet. Heavyweight cotton. No branding. A small tonal label that you had to squint to read. We loved it too — for a while.",
				),
				ptBlock("h2", "The case for a small mark"),
				ptBlock(
					"normal",
					"A logo, done sparingly, does two things a blank tee can't. It tells the wearer this piece is part of something — a shop, a scene, a point of view. And it lets other people recognise it without a caption.",
				),
				ptBlock("h2", "How we approached ours"),
				...ptList("bullet", [
					"2cm wide, centred at the chest — smaller than a coin.",
					"Tonal embroidery, not print: matte thread on matte fabric.",
					"220gsm ringspun cotton, pre-washed. Same body as the blank.",
				]),
				ptBlock(
					"normal",
					"The goal isn't to make the logo the point. The goal is to make the logo the reason the tee has a point.",
				),
			],
		},
		taxonomies: { post_category: ["product-stories"] },
	},
	{
		id: "post-how-to-pick-a-subscription",
		slug: "how-to-pick-a-subscription-box",
		status: "published",
		data: {
			title: "How to Pick the Right Subscription Box",
			excerpt:
				"Four questions we ask any customer who's on the fence between our Monthly, Quarterly, and Annual plans.",
			cover_gradient: "linear-gradient(135deg, #001433 0%, #0b0b0b 100%)",
			author_name: "Theo Park",
			published_date: "2026-02-14T09:00:00.000Z",
			reading_minutes: 3,
			body: [
				ptBlock(
					"normal",
					"Subscription fatigue is real. Before you sign up for anything — ours or anyone else's — ask yourself these four things.",
				),
				ptBlock("h2", "1. How often do you actually need new things?"),
				ptBlock(
					"normal",
					"If the honest answer is 'rarely,' a monthly box will sit unopened and you'll resent it. Quarterly or annual is almost always the better pick.",
				),
				ptBlock("h2", "2. Do you trust the curator?"),
				ptBlock(
					"normal",
					"Subscription boxes live or die on taste. Read one issue of the curator's newsletter or look at their Instagram. If their eye doesn't match yours, a discount won't fix it.",
				),
				ptBlock("h2", "3. Can you pause?"),
				ptBlock(
					"normal",
					"Most good subscriptions let you skip or pause. Check this before you sign up — not after.",
				),
				ptBlock("h2", "4. What's the exit?"),
				ptBlock(
					"normal",
					"Look for a one-click cancel link inside the account page. If you can't find it in the T&Cs, that's your answer.",
				),
			],
		},
		taxonomies: { post_category: ["buying-guides"] },
	},
	{
		id: "post-the-digital-download",
		slug: "the-quiet-return-of-the-digital-download",
		status: "published",
		data: {
			title: "The Quiet Return of the Digital Download",
			excerpt:
				"Streaming was meant to be the end of ownership. Our digital download numbers have tripled. Here's what's going on.",
			cover_gradient: "linear-gradient(135deg, #00102a 0%, #0b0b0b 100%)",
			author_name: "Maren Osei",
			published_date: "2026-02-02T09:00:00.000Z",
			reading_minutes: 5,
			body: [
				ptBlock(
					"normal",
					"A quiet thing has been happening inside the catalogue. Over the last 18 months, our digital download sales have grown three times faster than the rest of the shop. They're a quarter of revenue now.",
				),
				ptBlock("h2", "People are buying again"),
				ptBlock(
					"normal",
					"A decade of 'streaming-everything' built a generation of customers who realised they don't own any of the things they pay for. A paid-once, forever-downloadable file is, by contrast, radically calm.",
				),
				ptBlock("h2", "What's selling"),
				...ptList("bullet", [
					"Lightroom + Capture One presets — up 312% YoY.",
					"High-res icon packs — up 180%.",
					"Brush and texture sets — up 145%.",
					"Printable zines — surprisingly strong, up 98%.",
				]),
				ptBlock(
					"blockquote",
					"Digital goods are having a second wind because owning something — anything — feels novel again.",
				),
			],
		},
		taxonomies: { post_category: ["product-stories"] },
	},
	{
		id: "post-gifting-guide",
		slug: "the-gifting-guide-for-people-who-dont-do-gifts",
		status: "published",
		data: {
			title: "The Gifting Guide for People Who Don't Do Gifts",
			excerpt:
				"Seven quietly excellent things from The Edit, picked for the hardest person on your list: the one who says they don't want anything.",
			cover_gradient: "linear-gradient(135deg, #1a001f 0%, #0b0b0b 100%)",
			author_name: "Priya Nair",
			published_date: "2026-01-20T09:00:00.000Z",
			reading_minutes: 4,
			body: [
				ptBlock(
					"normal",
					"Every year someone on your list says they don't want anything. They're usually lying — they just don't want bad things. Here's what we'd pick.",
				),
				ptBlock("h2", "Under £30"),
				ptBlock(
					"normal",
					"The enamel mug. Nothing about it screams gift, which is exactly why it works as one. A mug that looks good on a shelf for ten years is a better present than a scented candle they'll burn in three.",
				),
				ptBlock("h2", "Under £75"),
				ptBlock(
					"normal",
					"Pair the logo tee with the starter bundle — it lands as a thoughtful set rather than one obvious thing.",
				),
				ptBlock("h2", "Under £150"),
				ptBlock(
					"normal",
					"The quarterly subscription. It spreads the gift across four seasons; you get to be the 'something nice showed up today' friend three more times.",
				),
				ptBlock(
					"normal",
					"The secret to gifting people who don't do gifts is to give them permission to keep the thing around without feeling guilty about it. Quietly excellent objects — mugs, tees, well-designed software — pass that test.",
				),
			],
		},
		taxonomies: { post_category: ["buying-guides"] },
	},
];

// ─────────────────────────────────────────────────────────────────────────────
//  Banners: reusable promo blocks
// ─────────────────────────────────────────────────────────────────────────────
//
// A banner is a one-off "hero-lite" block that storefronts render by slug.
// The homepage's Mid Banner is just the `home-promise` banner. To add a new
// promo zone to any page, create a banner in the admin and drop a
// <Banner slug="your-banner"/> wherever you want it. The field set mirrors
// hero_slides so merchants only learn one mental model.
//
const bannersCollection = {
	slug: "banners",
	label: "Banners",
	labelSingular: "Banner",
	description:
		"Reusable promo blocks. Look them up by slug from any page template (e.g. the homepage 'Our promise' section is the `home-promise` banner).",
	icon: "megaphone",
	supports: ["drafts"],
	fields: [
		{
			slug: "internal_name",
			label: "Internal name",
			type: "string",
			required: true,
			help: "Admin-only label. Not shown on the storefront.",
		},
		{
			slug: "eyebrow",
			label: "Eyebrow",
			type: "string",
			required: false,
			help: "Short uppercase kicker above the headline (e.g. 'Our promise').",
		},
		{
			slug: "headline",
			label: "Headline",
			type: "string",
			required: true,
			help: "Main banner title. Use `\\n` to force a line break.",
		},
		{
			slug: "body",
			label: "Body",
			type: "portableText",
			required: false,
			help: "Rich body copy — supports bold, links, and short lists.",
		},
		{
			slug: "primary_cta_label",
			label: "Primary CTA label",
			type: "string",
			required: false,
		},
		{
			slug: "primary_cta_href",
			label: "Primary CTA link",
			type: "string",
			required: false,
		},
		{
			slug: "secondary_cta_label",
			label: "Secondary CTA label",
			type: "string",
			required: false,
			help: "Optional second CTA. Rendered as an outline button next to the primary.",
		},
		{
			slug: "secondary_cta_href",
			label: "Secondary CTA link",
			type: "string",
			required: false,
		},
		{
			slug: "theme",
			label: "Theme",
			type: "select",
			required: false,
			defaultValue: "dark",
			options: [
				{ value: "dark", label: "Dark (light text on dark bg)" },
				{ value: "light", label: "Light (dark text on light bg)" },
			],
		},
		{
			slug: "alignment",
			label: "Text alignment",
			type: "select",
			required: false,
			defaultValue: "left",
			options: [
				{ value: "left", label: "Left" },
				{ value: "center", label: "Center" },
				{ value: "right", label: "Right" },
			],
		},
		{
			slug: "bg_type",
			label: "Background type",
			type: "select",
			required: false,
			defaultValue: "gradient",
			widget: "dashcommerce:bg-type-select",
			options: [
				{ value: "gradient", label: "Gradient / CSS" },
				{ value: "image", label: "Image" },
				{ value: "video", label: "Video (MP4, YouTube, Vimeo)" },
			],
			help: "Switching this reveals only the fields you need. The storefront also auto-picks Video URL > Image > Gradient as a fallback.",
		},
		{
			slug: "bg_css",
			label: "Gradient / CSS (fallback background)",
			type: "string",
			required: false,
			defaultValue: "linear-gradient(135deg, #1a1000 0%, #0b0b0b 100%)",
			help: "Used when no image or video is set. Any valid CSS background.",
		},
		{
			slug: "bg_image",
			label: "Background image",
			type: "image",
			required: false,
			help: "If set, takes precedence over the gradient. Leave empty to use the gradient.",
		},
		{
			slug: "bg_focal_point",
			label: "Image focal point",
			type: "string",
			required: false,
			defaultValue: "center",
			help: "Applies when a background image is set. CSS object-position (e.g. 'center', 'top right', '30% 60%').",
		},
		{
			slug: "bg_video_url",
			label: "Video URL (highest priority)",
			type: "string",
			required: false,
			help: "If set, overrides both the image and the gradient. Paste a direct MP4/WebM URL, a YouTube link, or a Vimeo link.",
		},
		{
			slug: "bg_video_poster",
			label: "Video poster",
			type: "image",
			required: false,
		},
		{
			slug: "bg_overlay",
			label: "Overlay (over image/video)",
			type: "string",
			required: false,
			help: "CSS background layered over image/video for legibility. E.g. 'rgba(0,0,0,.45)'.",
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Trust items: homepage trust strip
// ─────────────────────────────────────────────────────────────────────────────
//
// Small collection of "why shop with us" bullets rendered as the strip just
// above the footer. Each item is a symbol/icon + title + one-line description.
//
const trustItemsCollection = {
	slug: "trust_items",
	label: "Trust Items",
	labelSingular: "Trust Item",
	description:
		"Homepage 'trust strip' items — small benefit-bullets shown above the footer (free shipping, secure checkout, etc.).",
	icon: "shield-check",
	supports: ["drafts"],
	fields: [
		{
			slug: "icon",
			label: "Icon / symbol",
			type: "string",
			required: false,
			defaultValue: "✦",
			help: "A single-character symbol or emoji used as the item's visual mark.",
		},
		{
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		},
		{
			slug: "description",
			label: "Description",
			type: "string",
			required: false,
		},
		{
			slug: "sort_order",
			label: "Sort order",
			type: "integer",
			required: false,
			defaultValue: 10,
			help: "Lower numbers appear first. Leave gaps (10, 20, 30) to make reordering easy.",
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Category tiles: homepage bento
// ─────────────────────────────────────────────────────────────────────────────
//
// Powers the "Browse by type" bento grid on the homepage. Each tile links
// somewhere (usually a taxonomy page), has a label + description, a
// background (gradient or image), and a size that controls the bento layout.
//
const categoryTilesCollection = {
	slug: "category_tiles",
	label: "Category Tiles",
	labelSingular: "Category Tile",
	description:
		"Powers the homepage 'Browse by type' bento grid. Each tile links to a category page and has a size that controls how it lays out.",
	icon: "grid-2x2",
	supports: ["drafts"],
	fields: [
		{
			slug: "label",
			label: "Label",
			type: "string",
			required: true,
			help: "Big title shown on the tile (e.g. 'Physical Goods').",
		},
		{
			slug: "description",
			label: "Description",
			type: "string",
			required: false,
			help: "Small kicker shown above the label.",
		},
		{
			slug: "href",
			label: "Link",
			type: "string",
			required: true,
			help: "Where the tile goes when clicked (e.g. '/category/physical-goods').",
		},
		{
			slug: "size",
			label: "Size",
			type: "select",
			required: false,
			defaultValue: "large",
			options: [
				{ value: "large", label: "Large (spans 2 columns)" },
				{ value: "small", label: "Small (spans 1 column)" },
			],
			help: "Controls how the tile lays out in the bento grid.",
		},
		{
			slug: "bg_css",
			label: "Background gradient / CSS",
			type: "string",
			required: false,
			defaultValue: "linear-gradient(135deg, #2d1800 0%, #0b0b0b 100%)",
			help: "Any valid CSS background. Used as a fallback behind the image.",
		},
		{
			slug: "image",
			label: "Background image",
			type: "image",
			required: false,
			help: "Optional. If set, shown over the gradient with a dark overlay.",
		},
		{
			slug: "sort_order",
			label: "Sort order",
			type: "integer",
			required: false,
			defaultValue: 10,
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Announcements: top bar + marquee strip
// ─────────────────────────────────────────────────────────────────────────────
//
// One collection powers two surfaces:
//   - The thin bar at the very top of every page (location = "top_bar")
//   - The large scrolling strip between the hero and the bento on the
//     homepage (location = "marquee").
//
// Merchants just toggle `enabled` to turn individual messages on/off; any
// disabled item disappears from both surfaces.
//
const announcementsCollection = {
	slug: "announcements",
	label: "Announcements",
	labelSingular: "Announcement",
	description:
		"Messages shown in the top bar and/or the homepage marquee strip. Toggle `enabled` to show/hide without deleting.",
	icon: "megaphone",
	supports: ["drafts"],
	fields: [
		{
			slug: "message",
			label: "Message",
			type: "string",
			required: true,
		},
		{
			slug: "location",
			label: "Show in",
			type: "select",
			required: false,
			defaultValue: "both",
			options: [
				{ value: "top_bar", label: "Top bar only" },
				{ value: "marquee", label: "Marquee strip only" },
				{ value: "both", label: "Both" },
			],
		},
		{
			slug: "href",
			label: "Link (optional)",
			type: "string",
			required: false,
			help: "If set, the message becomes a link.",
		},
		{
			slug: "enabled",
			label: "Enabled",
			type: "boolean",
			required: false,
			defaultValue: true,
		},
		{
			slug: "sort_order",
			label: "Sort order",
			type: "integer",
			required: false,
			defaultValue: 10,
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Site text: singleton-style collection for homepage/footer copy
// ─────────────────────────────────────────────────────────────────────────────
//
// emdash's native Site Settings schema is strongly typed (title, tagline,
// social.*, seo.*). Instead of bending it, we use a regular collection with
// a SINGLE entry (slug = "main") to hold every free-form piece of copy for
// the homepage section headers and the footer.
//
// Templates read this via `getEmDashEntry("site_text", "main")`.
//
const siteTextCollection = {
	slug: "site_text",
	label: "Site Text",
	labelSingular: "Site Text",
	description:
		"Footer-specific copy that doesn't belong on native Site Settings — newsletter strip, copyright template, and overrides for the footer tagline. Identity (title, tagline, logo, social) lives under Site Settings. Homepage section headers live under Section Headers.",
	icon: "type",
	supports: ["drafts"],
	fields: [
		// ── Footer ──────────────────────────────────────────────────────
		{
			slug: "footer_tagline",
			label: "Footer tagline override",
			type: "text",
			help: "Leave blank to use the site tagline from Site Settings. Set to customise the footer brand block specifically.",
		},
		{
			slug: "footer_newsletter_title",
			label: "Footer newsletter title",
			type: "string",
			defaultValue: "Stay in the loop",
		},
		{
			slug: "footer_newsletter_body",
			label: "Footer newsletter body",
			type: "text",
			defaultValue:
				"New arrivals, exclusive offers, and carefully chosen recommendations.",
		},
		{
			slug: "footer_newsletter_placeholder",
			label: "Footer newsletter input placeholder",
			type: "string",
			defaultValue: "your@email.com",
		},
		{
			slug: "footer_newsletter_cta",
			label: "Footer newsletter button label",
			type: "string",
			defaultValue: "Subscribe",
		},
		{
			slug: "footer_copyright",
			label: "Footer copyright template",
			type: "string",
			defaultValue: "© {year} {title}. All rights reserved.",
			help: "Placeholders: `{year}` is the current year, `{title}` is the site title from Site Settings.",
		},
		{
			slug: "social_pinterest",
			label: "Social · Pinterest URL",
			type: "string",
			required: false,
			help: "Instagram/Twitter and other major channels are managed on Site Settings. Pinterest lives here because EmDash's native social schema doesn't include it yet.",
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Section headers: per-section homepage / page bands
// ─────────────────────────────────────────────────────────────────────────────
//
// Previously the homepage section eyebrows/titles (Bento, Products, Journal,
// …) lived as flat fields on the singleton `site_text` entry. That made the
// admin form huge and gave editors no way to style a section header's
// background to match the items below (bento category tiles have their own
// backgrounds, product card art is gradient-heavy, etc.).
//
// This collection is a list — one entry per section — and each entry carries
// the same `bg_*` fields as the Banners collection (and uses the same
// `dashcommerce:bg-type-select` widget, so only the relevant sub-fields are
// shown in the admin). Entries are keyed by slug: `homepage-bento`,
// `homepage-products`, `homepage-journal`, etc. Pages look them up by slug.
//
// If a page wants the section to render as a plain "eyebrow + title" row
// (no background band), it can leave `render_mode` as `compact` and ignore
// the bg_* fields.
//
const sectionHeadersCollection = {
	slug: "section_headers",
	label: "Section Headers",
	labelSingular: "Section Header",
	description:
		"Eyebrow + title + optional body & CTA for each content band (homepage Bento, Products, Journal, etc.). Each entry can optionally carry a full background (gradient / image / video) so section intros can coordinate with the visuals of the items beneath them.",
	icon: "layout-template",
	supports: ["drafts"],
	fields: [
		{
			slug: "label",
			label: "Admin label",
			type: "string",
			required: true,
			help: "Internal name shown in the admin list — e.g. 'Homepage · Bento'. Not rendered on the site.",
		},
		{
			slug: "eyebrow",
			label: "Eyebrow",
			type: "string",
			required: false,
			help: "Small uppercase kicker shown above the title (e.g. 'Browse by type').",
		},
		{
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
			help: "Main heading. Use `\\n` to force a line break — the second line is rendered italic to match the homepage style.",
		},
		{
			slug: "subtitle",
			label: "Subtitle",
			type: "text",
			required: false,
			help: "Optional supporting paragraph under the title.",
		},
		{
			slug: "cta_label",
			label: "CTA label",
			type: "string",
			required: false,
		},
		{
			slug: "cta_href",
			label: "CTA URL",
			type: "string",
			required: false,
		},
		{
			slug: "render_mode",
			label: "Render style",
			type: "select",
			required: false,
			defaultValue: "compact",
			options: [
				{ value: "compact", label: "Compact (simple eyebrow + title)" },
				{ value: "band", label: "Band (full-width with background)" },
			],
			help: "Compact mirrors the plain section intros of most e-commerce sites. Band wraps the header in a full-width panel using the background fields below — use this when the items below have their own strong visuals (e.g. the Bento tiles).",
		},
		{
			slug: "theme",
			label: "Theme (when rendered as a band)",
			type: "select",
			required: false,
			defaultValue: "dark",
			options: [
				{ value: "dark", label: "Dark text on light bg" },
				{ value: "light", label: "Light text on dark bg" },
			],
		},
		{
			slug: "alignment",
			label: "Text alignment",
			type: "select",
			required: false,
			defaultValue: "left",
			options: [
				{ value: "left", label: "Left" },
				{ value: "center", label: "Center" },
				{ value: "right", label: "Right" },
			],
		},
		// ── Background (only relevant when render_mode = "band") ────────
		{
			slug: "bg_type",
			label: "Background type",
			type: "select",
			required: false,
			defaultValue: "gradient",
			widget: "dashcommerce:bg-type-select",
			options: [
				{ value: "gradient", label: "Gradient / CSS" },
				{ value: "image", label: "Image" },
				{ value: "video", label: "Video (MP4, YouTube, Vimeo)" },
			],
			help: "Only applies when render style is 'Band'. Switching reveals only the fields you need.",
		},
		{
			slug: "bg_css",
			label: "Gradient / CSS",
			type: "string",
			required: false,
			defaultValue: "linear-gradient(135deg, #1a1000 0%, #0b0b0b 100%)",
		},
		{
			slug: "bg_image",
			label: "Background image",
			type: "image",
			required: false,
		},
		{
			slug: "bg_focal_point",
			label: "Image focal point",
			type: "string",
			required: false,
			defaultValue: "center",
			help: "CSS object-position (e.g. 'center', 'top right', '30% 60%').",
		},
		{
			slug: "bg_video_url",
			label: "Video URL",
			type: "string",
			required: false,
			help: "MP4/WebM direct URL, YouTube, or Vimeo link.",
		},
		{
			slug: "bg_video_poster",
			label: "Video poster",
			type: "image",
			required: false,
		},
		{
			slug: "bg_overlay",
			label: "Overlay (over image/video)",
			type: "string",
			required: false,
			defaultValue:
				"linear-gradient(180deg, rgba(11,11,11,.55) 0%, rgba(11,11,11,.8) 100%)",
			help: "CSS layer placed over image/video backgrounds to keep the text legible.",
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Demo data for the new collections
// ─────────────────────────────────────────────────────────────────────────────

interface GenericEntry {
	id: string;
	slug: string;
	status: "published";
	data: Record<string, unknown>;
}

const demoBanners: GenericEntry[] = [
	{
		id: "banner-home-promise",
		slug: "home-promise",
		status: "published",
		data: {
			internal_name: "Homepage · Our promise",
			eyebrow: "Our promise",
			headline: "Quality goods,\nwithout compromise.",
			body: [
				{
					_type: "block",
					_key: "pb1",
					style: "normal",
					markDefs: [],
					children: [
						{
							_type: "span",
							_key: "ps1",
							marks: [],
							text: "Every product in The Edit is selected for quality, function, and lasting value. We don't chase trends — we curate things worth keeping.",
						},
					],
				},
			],
			primary_cta_label: "Explore the full catalog",
			primary_cta_href: "/shop",
			secondary_cta_label: "Read our story",
			secondary_cta_href: "/about",
			theme: "dark",
			alignment: "left",
			bg_type: "gradient",
			bg_css: "linear-gradient(135deg, #1a1000 0%, #0b0b0b 100%)",
		},
	},
];

const demoTrustItems: GenericEntry[] = [
	{
		id: "trust-shipping",
		slug: "free-shipping",
		status: "published",
		data: {
			icon: "✦",
			title: "Free Shipping",
			description: "On all orders over $75",
			sort_order: 10,
		},
	},
	{
		id: "trust-checkout",
		slug: "secure-checkout",
		status: "published",
		data: {
			icon: "◈",
			title: "Secure Checkout",
			description: "Stripe-powered, PCI compliant",
			sort_order: 20,
		},
	},
	{
		id: "trust-returns",
		slug: "returns",
		status: "published",
		data: {
			icon: "↺",
			title: "30-Day Returns",
			description: "No questions asked",
			sort_order: 30,
		},
	},
	{
		id: "trust-downloads",
		slug: "instant-downloads",
		status: "published",
		data: {
			icon: "⬇",
			title: "Instant Downloads",
			description: "Digital goods, immediately",
			sort_order: 40,
		},
	},
];

const demoCategoryTiles: GenericEntry[] = [
	{
		id: "tile-physical",
		slug: "physical-goods",
		status: "published",
		data: {
			label: "Physical Goods",
			description: "Everyday objects, made well",
			href: "/category/physical-goods",
			size: "large",
			bg_css: "linear-gradient(135deg, #2d1800 0%, #0b0b0b 100%)",
			sort_order: 10,
		},
	},
	{
		id: "tile-digital",
		slug: "digital-downloads",
		status: "published",
		data: {
			label: "Digital Downloads",
			description: "Instant access, no shipping",
			href: "/category/digital-downloads",
			size: "small",
			bg_css: "linear-gradient(135deg, #001433 0%, #0b0b0b 100%)",
			sort_order: 20,
		},
	},
	{
		id: "tile-subscriptions",
		slug: "monthly-boxes",
		status: "published",
		data: {
			label: "Monthly Boxes",
			description: "Curated and delivered",
			href: "/category/subscriptions",
			size: "small",
			bg_css: "linear-gradient(135deg, #001a0a 0%, #0b0b0b 100%)",
			sort_order: 30,
		},
	},
	{
		id: "tile-bundles",
		slug: "bundles",
		status: "published",
		data: {
			label: "Bundles",
			description: "More value, less friction",
			href: "/category/bundles",
			size: "large",
			bg_css: "linear-gradient(135deg, #1a001f 0%, #0b0b0b 100%)",
			sort_order: 40,
		},
	},
];

const demoAnnouncements: GenericEntry[] = [
	{
		id: "ann-shipping",
		slug: "free-shipping",
		status: "published",
		data: {
			message: "Free shipping on orders over $75",
			location: "both",
			enabled: true,
			sort_order: 10,
		},
	},
	{
		id: "ann-returns",
		slug: "thirty-day-returns",
		status: "published",
		data: {
			message: "30-day returns, no questions asked",
			location: "top_bar",
			enabled: true,
			sort_order: 20,
		},
	},
	{
		id: "ann-stripe",
		slug: "secure-checkout",
		status: "published",
		data: {
			message: "Secure checkout powered by Stripe",
			location: "top_bar",
			enabled: true,
			sort_order: 30,
		},
	},
	{
		id: "ann-new",
		slug: "new-arrivals",
		status: "published",
		data: {
			message: "New arrivals every week",
			location: "top_bar",
			enabled: true,
			sort_order: 40,
		},
	},
	{
		id: "ann-digital",
		slug: "digital-instant",
		status: "published",
		data: {
			message: "Digital downloads — instant access",
			location: "top_bar",
			enabled: true,
			sort_order: 50,
		},
	},
	// Marquee-only decorative labels
	{
		id: "ann-m-physical",
		slug: "m-physical",
		status: "published",
		data: {
			message: "Physical Goods",
			location: "marquee",
			enabled: true,
			sort_order: 100,
		},
	},
	{
		id: "ann-m-digital",
		slug: "m-digital",
		status: "published",
		data: {
			message: "Digital Downloads",
			location: "marquee",
			enabled: true,
			sort_order: 110,
		},
	},
	{
		id: "ann-m-subs",
		slug: "m-subs",
		status: "published",
		data: {
			message: "Subscriptions",
			location: "marquee",
			enabled: true,
			sort_order: 120,
		},
	},
	{
		id: "ann-m-bundles",
		slug: "m-bundles",
		status: "published",
		data: {
			message: "Curated Bundles",
			location: "marquee",
			enabled: true,
			sort_order: 130,
		},
	},
	{
		id: "ann-m-stripe",
		slug: "m-stripe",
		status: "published",
		data: {
			message: "Stripe Secure",
			location: "marquee",
			enabled: true,
			sort_order: 140,
		},
	},
];

const demoSiteText: GenericEntry[] = [
	{
		id: "site-text-main",
		slug: "main",
		status: "published",
		data: {
			// footer_tagline intentionally unset — falls back to the
			// site tagline from Site Settings. Editors can set a
			// footer-specific override here.
			footer_newsletter_title: "Stay in the loop",
			footer_newsletter_body:
				"New arrivals, exclusive offers, and carefully chosen recommendations.",
			footer_newsletter_placeholder: "your@email.com",
			footer_newsletter_cta: "Subscribe",
			footer_copyright: "© {year} {title}. All rights reserved.",
			social_pinterest: "https://pinterest.com/",
		},
	},
];

// Homepage section headers. Each entry drives one section's eyebrow + title
// block on the homepage. Admins edit these in
// `/_emdash/admin/content/section_headers/<slug>`.
//
// `homepage-bento` is seeded as a full-width band with a dark gradient so it
// visually "holds" the category tiles (which have their own strong
// backgrounds). `homepage-products` and `homepage-journal` stay compact —
// clean eyebrow + title lines — but editors can flip them to bands from the
// admin whenever they want a more editorial layout.
const demoSectionHeaders: GenericEntry[] = [
	{
		id: "section-homepage-bento",
		slug: "homepage-bento",
		status: "published",
		data: {
			label: "Homepage · Bento (categories)",
			eyebrow: "Browse by type",
			title: "Everything you need,\nin one place",
			subtitle:
				"Four ways to shop — from everyday objects to digital downloads and curated monthly boxes.",
			render_mode: "band",
			theme: "light",
			alignment: "left",
			bg_type: "gradient",
			bg_css:
				"radial-gradient(ellipse at 20% 0%, #1a1000 0%, #0b0b0b 55%, #000 100%)",
			bg_overlay:
				"linear-gradient(180deg, rgba(11,11,11,0) 0%, rgba(11,11,11,.25) 100%)",
		},
	},
	{
		id: "section-homepage-products",
		slug: "homepage-products",
		status: "published",
		data: {
			label: "Homepage · Products (shop grid)",
			eyebrow: "The selection",
			title: "New in\nthis season",
			render_mode: "compact",
			theme: "dark",
			alignment: "left",
			cta_label: "View all products",
			cta_href: "/shop",
		},
	},
	{
		id: "section-homepage-journal",
		slug: "homepage-journal",
		status: "published",
		data: {
			label: "Homepage · Journal (posts)",
			eyebrow: "The Journal",
			title: "From the editors",
			subtitle:
				"Product stories, buying guides, and notes from the workshop.",
			render_mode: "compact",
			theme: "dark",
			alignment: "left",
			cta_label: "View all posts",
			cta_href: "/blog",
		},
	},
];

const demoHeroSlides: HeroSlideEntry[] = [
	{
		id: "slide-new-arrivals",
		slug: "slide-new-arrivals",
		status: "published",
		data: {
			eyebrow: "New arrivals",
			headline: "Discover\nThe Collection",
			subtitle:
				"Curated physical goods, digital downloads and monthly boxes — all in one place.",
			cta_label: "Shop now",
			cta_href: "/shop",
			bg_type: "gradient",
			bg_css: "radial-gradient(ellipse at 70% 50%, #1a1000 0%, #0b0b0b 70%)",
			accent_css: "linear-gradient(90deg, #c8a46e, #8b6520)",
			sort_order: 10,
		},
	},
	{
		id: "slide-digital-goods",
		slug: "slide-digital-goods",
		status: "published",
		data: {
			eyebrow: "Digital goods",
			headline: "Instant\nAccess, Always",
			subtitle:
				"Download premium design assets, templates, and tools the moment you purchase.",
			cta_label: "Browse digital",
			cta_href: "/category/digital-downloads",
			bg_type: "gradient",
			bg_css: "radial-gradient(ellipse at 30% 60%, #00102a 0%, #0b0b0b 70%)",
			accent_css: "linear-gradient(90deg, #5b9bd5, #1a4a8a)",
			sort_order: 20,
		},
	},
	{
		id: "slide-subscriptions",
		slug: "slide-subscriptions",
		status: "published",
		data: {
			eyebrow: "Subscriptions",
			headline: "Curated Monthly,\nFor You",
			subtitle:
				"A thoughtfully assembled box of goods, delivered to your door every month.",
			cta_label: "Explore boxes",
			cta_href: "/category/subscriptions",
			bg_type: "gradient",
			bg_css: "radial-gradient(ellipse at 60% 40%, #001a0a 0%, #0b0b0b 70%)",
			accent_css: "linear-gradient(90deg, #4caf78, #1a5c35)",
			sort_order: 30,
		},
	},
];

const demoProducts = DEMO_PRODUCTS;

const productTaxonomies = defineProductTaxonomies().map((tax) => {
	if (tax.name === "product_category") {
		return { ...tax, terms: productCategoryTerms };
	}
	if (tax.name === "product_tag") {
		return { ...tax, terms: productTagTerms };
	}
	return tax;
});

/**
 * Primary storefront navigation. Stored as an emdash menu so merchants can
 * rename, reorder, add, or remove items from `/admin/menus/primary` without
 * touching code. We use `type: "custom"` (rather than `type: "taxonomy"`)
 * for the Shop sub-items because the storefront serves them under `/category/`
 * while emdash would otherwise derive `/product_category/...` from the
 * taxonomy name.
 *
 * Note: the "Account" link intentionally does NOT appear here — it's already
 * surfaced as an icon button in the header actions (next to the cart drawer),
 * matching the ecommerce convention of keeping identity + cart together.
 */
const primaryMenu = {
	name: "primary",
	label: "Primary navigation",
	items: [
		{
			type: "custom",
			label: "Shop",
			url: "/shop",
			// Children become the mega-menu cards on desktop and a nested
			// section on mobile. `cssClasses` lets the template pick a
			// gradient per card without hardcoding anything.
			children: [
				{
					type: "custom",
					label: "Physical Goods",
					url: "/category/physical-goods",
					titleAttr: "Everyday objects, made well",
					cssClasses: "grad-amber",
				},
				{
					type: "custom",
					label: "Digital Downloads",
					url: "/category/digital-downloads",
					titleAttr: "Instant access, no shipping",
					cssClasses: "grad-blue",
				},
				{
					type: "custom",
					label: "Subscriptions",
					url: "/category/subscriptions",
					titleAttr: "Curated monthly deliveries",
					cssClasses: "grad-green",
				},
				{
					type: "custom",
					label: "Bundles",
					url: "/category/bundles",
					titleAttr: "More for less, always",
					cssClasses: "grad-purple",
				},
			],
		},
		{
			type: "custom",
			label: "New",
			url: "/shop?sort=newest",
			cssClasses: "is-accent",
		},
		{
			type: "custom",
			label: "Journal",
			url: "/blog",
			titleAttr: "Product stories, buying guides and behind-the-scenes",
		},
		{
			type: "custom",
			label: "About",
			url: "/about",
		},
	],
};

// ── Footer menus ─────────────────────────────────────────────────────────────
//
// Four dedicated menus power the footer columns + bottom-bar legal nav. Each
// is editable independently from `/_emdash/admin/menus/{name}`.
//
const footerShopMenu = {
	name: "footer-shop",
	label: "Footer · Shop column",
	items: [
		{ type: "custom", label: "All Products", url: "/shop" },
		{ type: "custom", label: "Physical Goods", url: "/category/physical-goods" },
		{ type: "custom", label: "Digital Downloads", url: "/category/digital-downloads" },
		{ type: "custom", label: "Subscriptions", url: "/category/subscriptions" },
		{ type: "custom", label: "Bundles & Sets", url: "/category/bundles" },
	],
};

const footerAccountMenu = {
	name: "footer-account",
	label: "Footer · Account column",
	items: [
		{ type: "custom", label: "Your Account", url: "/account" },
		{ type: "custom", label: "Order History", url: "/account" },
		{ type: "custom", label: "Downloads", url: "/account" },
		{ type: "custom", label: "Subscriptions", url: "/subscriptions" },
	],
};

const footerHelpMenu = {
	name: "footer-help",
	label: "Footer · Help column",
	items: [
		{ type: "custom", label: "FAQ", url: "/shop" },
		{ type: "custom", label: "Shipping Policy", url: "/shop" },
		{ type: "custom", label: "Returns", url: "/shop" },
		{ type: "custom", label: "Contact", url: "/shop" },
	],
};

const footerLegalMenu = {
	name: "footer-legal",
	label: "Footer · Legal (bottom bar)",
	items: [
		{ type: "custom", label: "Privacy Policy", url: "/shop" },
		{ type: "custom", label: "Terms of Service", url: "/shop" },
	],
};

const seed = {
	$schema: "https://emdashcms.com/seed.schema.json",
	version: "1",
	meta: {
		name: "DashCommerce starter",
		description:
			"A Stripe-powered storefront with 6 demo products spanning every DashCommerce product type.",
		author: "DashCommerce",
	},
	// Native Site Settings — the starter's first-class identity store.
	// See https://docs.emdashcms.com/themes/creating-themes/#using-images
	// Editors rebrand the whole storefront from /_emdash/admin/settings.
	//
	// `logo` and `favicon` are intentionally left unset so fresh installs
	// get the starter's text/glyph wordmark; uploading a logo from the
	// admin immediately takes over.
	//
	// `social.pinterest` isn't in EmDash's typed schema, so pinterest URLs
	// are kept on the `site_text.main` singleton (see siteTextCollection
	// below) and read via `getSiteMeta()` in the starter.
	settings: {
		title: "My Shop",
		tagline: "A Stripe-powered storefront, editable entirely from the admin.",
		postsPerPage: 9,
		social: {
			instagram: "https://instagram.com/",
			twitter: "https://x.com/",
		},
		seo: {
			titleSeparator: " — ",
		},
	},
	collections: [
		defineProductsCollection(),
		heroSlidesCollection,
		postsCollection,
		bannersCollection,
		trustItemsCollection,
		categoryTilesCollection,
		announcementsCollection,
		siteTextCollection,
		sectionHeadersCollection,
	],
	taxonomies: [...productTaxonomies, postTaxonomy],
	menus: [
		primaryMenu,
		footerShopMenu,
		footerAccountMenu,
		footerHelpMenu,
		footerLegalMenu,
	],
	// emdash expects `content` as `{ [collection]: entries[] }`.
	// Each entry has `id` + `slug` + `status` + `data`; the collection
	// key on the wrapper tells emdash which collection to insert into.
	content: {
		products: demoProducts,
		hero_slides: demoHeroSlides,
		posts: demoPosts,
		banners: demoBanners,
		trust_items: demoTrustItems,
		category_tiles: demoCategoryTiles,
		announcements: demoAnnouncements,
		site_text: demoSiteText,
		section_headers: demoSectionHeaders,
	},
};

writeFileSync(".emdash/seed.json", JSON.stringify(seed, null, "\t") + "\n");
console.log(
	`Wrote .emdash/seed.json with ${demoProducts.length} products, ${demoHeroSlides.length} hero slides, ${demoPosts.length} posts, ${demoBanners.length} banner, ${demoTrustItems.length} trust items, ${demoCategoryTiles.length} category tiles, ${demoAnnouncements.length} announcements, ${demoSiteText.length} site_text entry, ${demoSectionHeaders.length} section headers, and 5 menus (primary + 4 footer).`,
);

/**
 * Colours for DashCommerce's admin screens.
 *
 * The admin renders inside EmDash's admin, which themes itself with Kumo
 * tokens (`--color-kumo-*`, `--text-color-kumo-*`) that switch between light
 * and dark with the admin's own mode. Every colour here resolves in three
 * steps, so the plugin follows the host theme:
 *
 *   1. a `--dc-*` variable, for sites that want to restyle DashCommerce;
 *   2. the matching Kumo token, so light and dark mode both work;
 *   3. a light-theme hex value, for hosts without Kumo.
 *
 * Admin components take colours only from here (test/admin-theme.test.ts
 * fails on a hex or rgb() colour anywhere else under src/admin).
 */

/**
 * Light fallbacks for the four tones (used where the host has no Kumo
 * tokens). Each is readable as text on white and on its own tint.
 */
export const TONE_FALLBACK = {
	info: "#1e3a8a",
	success: "#14532d",
	warning: "#78350f",
	danger: "#b91c1c",
} as const;

/**
 * Tone text: Kumo's tone colour blended with the theme's default text.
 * Kumo's raw warning orange and danger red are too light to read as text
 * in light mode; the blend darkens them in light mode and lightens them in
 * dark mode, keeping the hue.
 */
const tone = (name: string, fallback: string) =>
	`color-mix(in oklab, var(--text-color-kumo-${name}, ${fallback}) 60%, var(--text-color-kumo-default, ${fallback}))`;
const tint = (colour: string, percent: number) =>
	`color-mix(in srgb, ${colour} ${percent}%, var(--color-kumo-base, #fff))`;

const info = tone("info", TONE_FALLBACK.info);
const success = tone("success", TONE_FALLBACK.success);
const warning = tone("warning", TONE_FALLBACK.warning);
const danger = tone("danger", TONE_FALLBACK.danger);
const accent = "var(--color-kumo-brand, #2563eb)";

export const T = {
	/** Body text on cards and inputs. */
	text: "var(--dc-card-fg, var(--text-color-kumo-default, #18181b))",
	/** Headings and emphasis. */
	textStrong: "var(--text-color-kumo-strong, #09090b)",
	/**
	 * Secondary text: captions, table headers, meta lines. In a Kumo host it
	 * shares `--text-color-kumo-subtle` with `textSubtle` (Kumo has one muted
	 * text colour that meets AA); the two stay separate so `--dc-*` and the
	 * light fallbacks can still tell them apart.
	 */
	textMuted: "var(--dc-text-muted, var(--text-color-kumo-subtle, #3f3f46))",
	/** Hints and empty states. */
	textSubtle: "var(--dc-text-subtle, var(--text-color-kumo-subtle, #52525b))",
	/** Input placeholders and disabled controls only: too faint for labels. */
	textPlaceholder: "var(--text-color-kumo-placeholder, #71717a)",
	/** Form labels. */
	label: "var(--dc-label, var(--text-color-kumo-default, #3f3f46))",

	/** Cards, dialogs, popovers. */
	surface: "var(--dc-card-bg, var(--color-kumo-base, #fff))",
	/** Inset areas, disabled inputs, secondary buttons. */
	surfaceSunken: "var(--color-kumo-tint, #f4f4f5)",
	/** Highlighted or selected rows and options. */
	selected: `color-mix(in srgb, ${accent} 12%, transparent)`,

	inputBg: "var(--dc-input-bg, var(--color-kumo-control, #fff))",
	inputFg: "var(--dc-input-fg, var(--text-color-kumo-default, #18181b))",

	/** Input and control borders. */
	border: "var(--dc-border, var(--color-kumo-line, #d4d4d8))",
	/** Card outlines and row dividers. */
	hairline: "var(--dc-hairline, var(--color-kumo-hairline, #e4e4e7))",

	accent,
	accentSoft: `color-mix(in srgb, ${accent} 18%, transparent)`,

	/** Primary buttons: the inverse of the page, in either mode. */
	primaryBg: "var(--text-color-kumo-default, #111)",
	primaryFg: "var(--color-kumo-base, #fff)",
	/** Destructive buttons: a solid fill that keeps white text readable in either mode. */
	dangerBg: "#b91c1c",
	dangerBorder: "#991b1b",
	/** Text on solid danger or status fills. */
	onFill: "#fff",

	info,
	success,
	warning,
	danger,
	infoBg: tint(info, 10),
	successBg: tint(success, 10),
	warningBg: tint(warning, 12),
	dangerBg10: tint(danger, 10),

	/** Dialog backdrop. */
	scrim: "rgba(17, 17, 17, 0.45)",
	shadowSm: "0 1px 2px rgba(0, 0, 0, 0.04)",
	shadowMd: "0 6px 20px rgba(0, 0, 0, 0.12)",
	shadowLg: "0 20px 60px rgba(0, 0, 0, 0.25)",
} as const;

/** Callout and toast tones: background, text and border for each. */
export const TONES = {
	info: { bg: T.infoBg, fg: T.info, border: tint(info, 35) },
	success: { bg: T.successBg, fg: T.success, border: tint(success, 35) },
	warning: { bg: T.warningBg, fg: T.warning, border: tint(warning, 35) },
	error: { bg: T.dangerBg10, fg: T.danger, border: tint(danger, 35) },
} as const;

/**
 * Order, payment, subscription and review statuses: solid pills with white
 * text, unchanged from before. Each fill has at least 4.5:1 contrast with
 * white, so the pills read the same on light and dark pages.
 */
export const STATUS_FILL: Record<string, string> = {
	pending: "#78350f",
	processing: "#0066cc",
	"on-hold": "#8b5a2b",
	completed: "#2d7a3a",
	cancelled: "#7a2d2d",
	refunded: "#555",
	"partially-refunded": "#776",
	failed: "#a00",
	paid: "#2d7a3a",
	active: "#2d7a3a",
	trialing: "#0066cc",
	past_due: "#a00",
	canceled: "#555",
	approved: "#2d7a3a",
	rejected: "#a00",
	spam: "#555",
};
export const STATUS_FILL_DEFAULT = "#555";

/**
 * Backwards-compatible names from the first contrast fix (kept for anything
 * that imported them from the kit).
 */
export const DC_THEME = {
	cardBg: T.surface,
	cardFg: T.text,
	cardBorder: T.hairline,
	inputBg: T.inputBg,
	inputFg: T.inputFg,
	label: T.label,
	textMuted: T.textMuted,
	textSubtle: T.textSubtle,
	border: T.border,
} as const;

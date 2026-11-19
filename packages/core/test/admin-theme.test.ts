/**
 * DashCommerce's admin follows the EmDash admin's light and dark theme
 * (issue #44). Guards: no hard-coded colours outside the theme module,
 * readable light fallbacks, and only Kumo tokens that EmDash defines.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { STATUS_FILL, STATUS_FILL_DEFAULT, T, TONE_FALLBACK } from "../src/admin/theme";

const ADMIN_DIR = fileURLToPath(new URL("../src/admin", import.meta.url));
const THEME_FILE = join(ADMIN_DIR, "theme.ts");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|tsx)$/.test(name) ? [path] : [];
	});
}

/** The light value a `var(--a, var(--b, #hex))` chain ends in. */
function fallbackHex(token: string): string {
	const hexes = token.match(/#[0-9a-fA-F]{3,6}\b/g);
	if (!hexes) throw new Error(`no hex fallback in ${token}`);
	return hexes[hexes.length - 1] ?? "";
}

function luminance(hex: string): number {
	let h = hex.replace("#", "");
	if (h.length === 3) h = [...h].map((c) => c + c).join("");
	const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
	const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("admin theme", () => {
	it("keeps every colour in the theme module", () => {
		// A colour value in a string or attribute: "#rgb"/"#rrggbb(aa)" as a
		// whole token, or a colour function. Comments are ignored, and anchors
		// such as href="#add" don't match.
		const COLOUR =
			/["'`\s(,]#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})["'`\s),;]|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/;
		// Fragment links like href="#add" are not colours.
		const LINK_ATTR = /\b(?:href|to|id|htmlFor)=["'`{]*#[\w-]*["'`}]*/g;
		const stripComments = (src: string) =>
			src
				.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
				.replace(/(^|[^:])\/\/.*$/gm, "$1");
		const offenders = sourceFiles(ADMIN_DIR)
			.filter((file) => file !== THEME_FILE)
			.flatMap((file) =>
				stripComments(readFileSync(file, "utf8"))
					.split("\n")
					.map((line, i) => ({ line, at: `${relative(ADMIN_DIR, file)}:${i + 1}` }))
					.filter(({ line }) => COLOUR.test(line.replace(LINK_ATTR, "")))
					.map(({ at, line }) => `${at}  ${line.trim()}`),
			);
		expect(offenders).toEqual([]);
	});

	it("uses only Kumo tokens the EmDash admin defines", () => {
		const css = readFileSync(
			fileURLToPath(import.meta.resolve("@emdash-cms/admin/styles.css")),
			"utf8",
		);
		const theme = readFileSync(THEME_FILE, "utf8");
		const used = [...new Set(theme.match(/--(?:text-)?color-kumo-[a-z0-9-]+/g) ?? [])];
		expect(used.length).toBeGreaterThan(5);
		const missing = used.filter((name) => !css.includes(`${name}:`));
		expect(missing).toEqual([]);
	});

	it("keeps the light fallbacks readable (WCAG AA, 4.5:1)", () => {
		const surface = fallbackHex(T.surface);
		const pairs: Array<[string, string, string]> = [
			["text", T.text, surface],
			["textStrong", T.textStrong, surface],
			["textMuted", T.textMuted, surface],
			["textSubtle", T.textSubtle, surface],
			["textPlaceholder", T.textPlaceholder, surface],
			["label", T.label, surface],
			["inputFg", T.inputFg, fallbackHex(T.inputBg)],
			["text on sunken", T.text, fallbackHex(T.surfaceSunken)],
			["primary button", T.primaryFg, fallbackHex(T.primaryBg)],
			["danger button", T.onFill, fallbackHex(T.dangerBg)],
			...Object.entries(TONE_FALLBACK).map(
				([name, hex]) => [`${name} text`, hex, surface] as [string, string, string],
			),
		];
		const failing = pairs
			.map(([name, fg, bg]) => ({ name, ratio: contrast(fallbackHex(fg), bg) }))
			.filter((p) => p.ratio < 4.5);
		expect(failing).toEqual([]);
	});

	it("keeps white status text readable on every status pill", () => {
		const failing = [...Object.entries(STATUS_FILL), ["default", STATUS_FILL_DEFAULT]]
			.map(([status, fill]) => ({ status, ratio: contrast("#fff", fill ?? "") }))
			.filter((p) => p.ratio < 4.5);
		expect(failing).toEqual([]);
	});

	it("lets sites restyle DashCommerce through --dc-* variables first", () => {
		for (const token of [
			T.text,
			T.textMuted,
			T.textSubtle,
			T.label,
			T.surface,
			T.inputBg,
			T.inputFg,
			T.border,
			T.hairline,
		]) {
			expect(token.startsWith("var(--dc-")).toBe(true);
		}
	});
});

/**
 * BgTypeSelect — custom field widget for the `bg_type` field on content
 * collections that model a configurable background (hero_slides, banners,
 * possibly promo panels).
 *
 * It renders a plain <select> with the gradient/image/video options, but
 * the interesting bit happens in a side effect: when the value changes,
 * the widget hunts down sibling field rows by their well-known `field-*`
 * ids and toggles their visibility. That turns a schema with six flat
 * background-related fields into a UX that only ever shows the two or
 * three fields that actually apply to the selected mode.
 *
 * Why a DOM-level hider instead of a proper conditional field system:
 * emdash doesn't expose "show this field only when X" at the schema
 * level, and refactoring all six sub-fields into a single custom JSON
 * widget would have been a far bigger breaking change (schema migration,
 * seed data rewrite, storefront reshape). Hiding siblings at runtime
 * keeps the underlying data model unchanged — each sub-value is still
 * its own column/field, the admin just guides the editor toward the
 * relevant subset.
 *
 * The hider is defensive: if emdash's internal DOM structure shifts,
 * it degrades to "no-op" rather than crashing the form.
 */

import { useEffect, useMemo } from "react";

type BgTypeValue = "gradient" | "image" | "video";

export interface BgTypeSelectProps {
	value?: unknown;
	onChange?: (next: string) => void;
	label?: string;
	id?: string;
	required?: boolean;
	readOnly?: boolean;
}

// Which sub-fields belong to which bg_type mode. Anything NOT listed here
// stays visible (e.g. `accent_css`, `bg_overlay` — they're useful across
// modes, so we leave them alone).
const MODE_FIELDS: Record<BgTypeValue, string[]> = {
	gradient: ["bg_css"],
	image: ["bg_image", "bg_focal_point", "bg_overlay"],
	video: ["bg_video_url", "bg_video_poster", "bg_overlay"],
};

// The universe of sub-fields we might toggle. Keeping this explicit means
// adding a new bg-related field to a schema won't accidentally get hidden
// by a catch-all selector.
const ALL_BG_FIELDS: string[] = [
	"bg_css",
	"bg_image",
	"bg_focal_point",
	"bg_video_url",
	"bg_video_poster",
	"bg_overlay",
];

/**
 * Resolve the field's outermost wrapper in the form. Emdash's admin
 * renders each entry form as a stack of direct children under a
 * `.space-y-4` container. Walk up from the input until we hit that
 * container, then return the child we arrived from — that's the
 * field's row element.
 *
 * Falls back to the input's own two-levels-up ancestor if the class
 * isn't found (e.g. emdash renames it in a future release).
 */
function findFieldRow(slug: string): HTMLElement | null {
	const input = document.getElementById(`field-${slug}`);
	if (!input) return null;
	let cur: HTMLElement = input;
	let depth = 0;
	while (cur.parentElement && depth < 8) {
		const parent = cur.parentElement;
		const cls = typeof parent.className === "string" ? parent.className : "";
		if (cls.includes("space-y-") || cls.includes("space-y-4")) {
			return cur;
		}
		cur = parent;
		depth += 1;
	}
	// Fallback: the nearest label/wrapper is likely 1–2 levels above the
	// input. Returning the input itself is better than nothing — it will
	// at least hide the control even if its label is left floating.
	return (input.closest("label") as HTMLElement | null) ?? input;
}

function normalizeMode(raw: unknown): BgTypeValue {
	if (raw === "image" || raw === "video") return raw;
	return "gradient";
}

export function BgTypeSelect(props: BgTypeSelectProps) {
	const { value, onChange, label, id, required, readOnly } = props;
	const mode = useMemo<BgTypeValue>(() => normalizeMode(value), [value]);

	useEffect(() => {
		const visible = new Set(MODE_FIELDS[mode]);
		const applied: Array<{ el: HTMLElement; prev: string }> = [];

		function apply() {
			for (const slug of ALL_BG_FIELDS) {
				const row = findFieldRow(slug);
				if (!row) continue;
				const shouldShow = visible.has(slug);
				const prev = row.style.display;
				// Record the first time we touch a row so we can restore it
				// on unmount.
				if (!applied.some((a) => a.el === row)) {
					applied.push({ el: row, prev });
				}
				row.style.display = shouldShow ? "" : "none";
			}
		}

		// Run immediately, then again on the next frame to catch rows that
		// hydrate after us (repeaters, image pickers etc).
		apply();
		const raf1 = requestAnimationFrame(apply);
		const raf2 = requestAnimationFrame(() =>
			requestAnimationFrame(apply),
		);

		// If the form re-renders (e.g. a draft revision loads), re-apply.
		const form =
			(document.getElementById(`field-${ALL_BG_FIELDS[0]}`) as HTMLElement | null)
				?.closest("form, [role=form], .space-y-4") ?? document.body;
		const observer = new MutationObserver(() => {
			apply();
		});
		observer.observe(form, { childList: true, subtree: true });

		return () => {
			cancelAnimationFrame(raf1);
			cancelAnimationFrame(raf2);
			observer.disconnect();
			for (const { el, prev } of applied) {
				el.style.display = prev;
			}
		};
	}, [mode]);

	return (
		<label
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 4,
				margin: "0.5rem 0",
				fontSize: "0.85em",
				color: "var(--dc-label, #444)",
			}}
		>
			{label && <span>{label}</span>}
			<select
				id={id}
				value={mode}
				required={required}
				disabled={readOnly}
				onChange={(e) => onChange?.(e.target.value)}
				style={{
					border: "1px solid var(--dc-border, #d4d4d8)",
					borderRadius: 6,
					padding: "6px 10px",
					fontSize: "0.95em",
					background: "var(--dc-input-bg, #fff)",
					color: "var(--dc-text, inherit)",
				}}
			>
				<option value="gradient">Gradient (CSS)</option>
				<option value="image">Image</option>
				<option value="video">Video (URL)</option>
			</select>
			<span
				style={{
					fontSize: "0.75em",
					color: "var(--dc-hint, #6b7280)",
					marginTop: 2,
				}}
			>
				{mode === "gradient"
					? "Edit the gradient CSS below."
					: mode === "image"
						? "Upload an image below, then tune its focal point and overlay."
						: "Paste an MP4, YouTube, or Vimeo URL below and optionally a poster image."}
			</span>
		</label>
	);
}

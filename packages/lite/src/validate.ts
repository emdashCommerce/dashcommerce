/**
 * Small input validators. Lite avoids zod to stay well under the registry
 * bundle caps (128 KB per file, 256 KB total).
 */

export type Json = Record<string, unknown>;

export function asObject(value: unknown): Json {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: {};
}

/** A trimmed non-empty string no longer than `max`, else undefined. */
export function asString(value: unknown, max = 200): string | undefined {
	if (typeof value !== "string") return undefined;
	const s = value.trim();
	return s.length > 0 && s.length <= max ? s : undefined;
}

/** An integer in [min, max]. Accepts numeric strings (query strings). */
export function asInt(value: unknown, min: number, max: number): number | undefined {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n)) return undefined;
	return n >= min && n <= max ? n : undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function asEmail(value: unknown): string | undefined {
	const s = asString(value, 254);
	return s && EMAIL_RE.test(s) ? s : undefined;
}

/** Content entry ids are ULIDs; slugs are lowercase words. Both fit this. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function asId(value: unknown): string | undefined {
	const s = asString(value, 128);
	return s && ID_RE.test(s) ? s : undefined;
}

export interface Failure {
	ok: false;
	error: { code: string; message: string };
	[extra: string]: unknown;
}

export function fail(code: string, message: string, extra: Json = {}): Failure {
	return { ok: false, error: { code, message }, ...extra };
}

/**
 * Storage-layer utilities.
 */

/**
 * Best-effort detection of a unique-index violation from a storage put
 * that failed. emdash's storage adapters surface these as messages
 * containing "unique", "constraint", or "duplicate" — no structured
 * error code today. If the adapter surface evolves, update this
 * function in one place.
 */
export function isUniqueViolation(err: unknown): boolean {
	if (!err) return false;
	const msg =
		err instanceof Error ? err.message : typeof err === "string" ? err : "";
	return /unique|constraint|duplicate/i.test(msg);
}

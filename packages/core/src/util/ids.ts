/**
 * ID helpers.
 *
 * `randomId()` returns 32 hex characters (16 random bytes). It's NOT a
 * ULID — not sortable, not monotonic. It's a collision-resistant ID
 * suitable for storage row primary keys where ordering doesn't matter
 * (inventory ledger entries, coupon usage rows, refund rows, etc.).
 *
 * When sortability matters, use emdash's `ulid` export — that's
 * already used for content entry ids.
 */

export function randomId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

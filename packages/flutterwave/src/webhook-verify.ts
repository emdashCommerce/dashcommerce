/**
 * Flutterwave webhook verification. Web Crypto is not needed: Flutterwave's
 * v3 webhooks are authenticated with a shared secret, not an HMAC.
 *
 * From https://developer.flutterwave.com/docs/webhooks: when a merchant sets
 * a secret hash under Settings → Webhooks, Flutterwave sends it back verbatim
 * in the `verif-hash` header. The endpoint compares the two in constant time.
 * A missing header, a missing secret or a different value is a rejection.
 *
 * There is no timestamp and no signature over the body, so a captured
 * delivery can be replayed. Core's event-id dedupe and the live
 * `getPaymentStatus` check are what stop a replay from creating a second
 * order or an order Flutterwave's own records do not confirm.
 */

function constantTimeEqualStrings(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	// Length is not secret: a different-length hash can never match.
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) {
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}

export interface VerifyInput {
	/** The `verif-hash` header, exactly as received. */
	signatureHeader: string;
	/** The secret hash saved in Settings → Webhooks. */
	secret: string;
}

export interface VerifyResult {
	ok: boolean;
	reason?: string;
}

export function verifyFlutterwaveSecretHash(input: VerifyInput): VerifyResult {
	const header = input.signatureHeader?.trim() ?? "";
	if (!header) {
		return { ok: false, reason: "Missing verif-hash header" };
	}
	const secret = input.secret?.trim() ?? "";
	if (!secret) {
		return { ok: false, reason: "Missing Flutterwave secret hash for verification" };
	}
	if (!constantTimeEqualStrings(header, secret)) {
		return {
			ok: false,
			reason:
				"verif-hash does not match the secret hash saved for Flutterwave; copy it from Settings → Webhooks",
		};
	}
	return { ok: true };
}

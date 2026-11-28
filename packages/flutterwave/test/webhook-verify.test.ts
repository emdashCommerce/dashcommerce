import { describe, expect, it } from "bun:test";
import { verifyFlutterwaveSecretHash } from "../src/webhook-verify";

describe("verifyFlutterwaveSecretHash", () => {
	it("accepts the exact secret hash", () => {
		expect(
			verifyFlutterwaveSecretHash({
				signatureHeader: "s3cr3t-h4sh",
				secret: "s3cr3t-h4sh",
			}),
		).toEqual({ ok: true });
	});

	it("trims surrounding whitespace from the header and the secret", () => {
		expect(
			verifyFlutterwaveSecretHash({
				signatureHeader: "  s3cr3t-h4sh\n",
				secret: "s3cr3t-h4sh ",
			}).ok,
		).toBe(true);
	});

	it("refuses a different hash", () => {
		const result = verifyFlutterwaveSecretHash({
			signatureHeader: "wrong",
			secret: "s3cr3t-h4sh",
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("does not match");
	});

	it("refuses a different length without throwing", () => {
		expect(
			verifyFlutterwaveSecretHash({
				signatureHeader: "s3cr3t-h4sh-and-more",
				secret: "s3cr3t-h4sh",
			}).ok,
		).toBe(false);
	});

	it("refuses a missing header", () => {
		const result = verifyFlutterwaveSecretHash({ signatureHeader: "", secret: "s3cr3t-h4sh" });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Missing verif-hash header");
	});

	it("refuses a missing secret", () => {
		const result = verifyFlutterwaveSecretHash({
			signatureHeader: "s3cr3t-h4sh",
			secret: "  ",
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Missing Flutterwave secret hash");
	});
});

import { describe, expect, test } from "bun:test";
import { dashcommerce } from "../src/index";
import { createPlugin } from "../src/sandbox-entry";
import {
	EMDASH_VERSIONS_WITH_SHIPPED_PATCHES,
	SUPPORTED_EMDASH_PEER,
	checkEmDashVersion,
	detectEmDashVersionAtBuildTime,
	emDashPatchMismatchMessage,
	isEmDashVersionSupported,
	matchingShippedEmDashPatch,
	validateEmDashCompatibility,
	warnIfEmDashPatchMissing,
} from "../src/version-check";

function captureWarnings(fn: () => void): string {
	const warnings: string[] = [];
	const orig = console.warn;
	const origLog = console.log;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
	console.log = () => {};
	try {
		fn();
	} finally {
		console.warn = orig;
		console.log = origLog;
	}
	return warnings.join("\n");
}

describe("EmDash version compatibility", () => {
	test("peer string matches the dual range we advertise", () => {
		expect(SUPPORTED_EMDASH_PEER).toBe(">=0.37.0 <0.38.0 || >=1.1.0 <1.5.0");
	});

	test.each(["0.37.0", "0.37.9", "1.1.0", "1.1.9", "1.2.0", "1.3.0", "1.3.9", "1.4.0", "1.4.9"])("accepts supported %s", (version) => {
		expect(isEmDashVersionSupported(version)).toBe(true);
		expect(() => checkEmDashVersion(version)).not.toThrow();
	});

	test.each(["0.36.9", "0.38.0", "0.42.0", "1.0.0", "1.0.1", "1.5.0", "1.9.0", "2.0.0"])(
		"rejects unsupported %s",
		(version) => {
			expect(isEmDashVersionSupported(version)).toBe(false);
			expect(() => checkEmDashVersion(version)).toThrow(/incompatibility/);
		},
	);

	test("below-floor error still points at 0.1.5 as the 0.28-era pin", () => {
		expect(() => checkEmDashVersion("0.28.1")).toThrow(/@dashcommerce\/core@\^0\.1\.5/);
	});

	test("gap / too-new error lists both supported windows", () => {
		expect(() => checkEmDashVersion("0.38.0")).toThrow(SUPPORTED_EMDASH_PEER);
		expect(() => checkEmDashVersion("1.0.0")).toThrow(/not 1\.0\.0/);
	});

	test("shipped patches are version-exact including 1.4.0", () => {
		expect(EMDASH_VERSIONS_WITH_SHIPPED_PATCHES).toEqual([
			"0.37.0",
			"1.1.0",
			"1.2.0",
			"1.3.0",
			"1.3.1",
			"1.4.0",
		]);
		expect(matchingShippedEmDashPatch("1.4.0")).toBe("1.4.0");
		expect(matchingShippedEmDashPatch("1.4.1")).toBeNull();
		expect(emDashPatchMismatchMessage("1.4.0")).toBeNull();
		expect(emDashPatchMismatchMessage("1.4.1")).toMatch(/hashed dist/);
		expect(matchingShippedEmDashPatch("1.3.1")).toBe("1.3.1");
		expect(matchingShippedEmDashPatch("1.3.2")).toBeNull();
		expect(emDashPatchMismatchMessage("1.3.1")).toBeNull();
		expect(emDashPatchMismatchMessage("1.3.2")).toMatch(/hashed dist/);
		expect(matchingShippedEmDashPatch("1.3.0")).toBe("1.3.0");
		expect(emDashPatchMismatchMessage("1.3.0")).toBeNull();
		expect(matchingShippedEmDashPatch("1.2.0")).toBe("1.2.0");
		expect(matchingShippedEmDashPatch("1.2.1")).toBeNull();
		expect(matchingShippedEmDashPatch("1.1.5")).toBeNull();
		expect(emDashPatchMismatchMessage("1.2.0")).toBeNull();
		expect(emDashPatchMismatchMessage("1.2.1")).toMatch(/hashed dist/);
		expect(emDashPatchMismatchMessage("0.38.0")).toBeNull();
	});

	test("validateEmDashCompatibility warns when 1.4.x has no shipped patch", () => {
		const out = captureWarnings(() => validateEmDashCompatibility("1.4.1"));
		expect(out).toMatch(/1\.4\.0 patch will not apply to 1\.4\.1\+/);
	});
});

describe("unpatched EmDash version warns loudly", () => {
	test("in-range but unpatched message is loud and names the breakage", () => {
		const message = emDashPatchMismatchMessage("1.3.2");
		expect(message).not.toBeNull();
		expect(message).toMatch(/^!{72}\n/);
		expect(message).toMatch(/\n!{72}$/);
		expect(message).toContain("WARNING: no DashCommerce patch ships for EmDash 1.3.2");
		expect(message).toContain("Shipped patches: 0.37.0, 1.1.0, 1.2.0, 1.3.0, 1.3.1, 1.4.0.");
		expect(message).toMatch(/webhooks fail/);
		expect(message).toMatch(/Set-Cookie is dropped/);
	});

	test.each(["1.3.0", "1.3.1", "1.4.0"])("stays quiet for shipped %s", (version) => {
		expect(captureWarnings(() => validateEmDashCompatibility(version))).toBe("");
		expect(warnIfEmDashPatchMissing(version)).toBeNull();
	});

	test("does not warn about patches for out-of-range versions (createPlugin throws instead)", () => {
		expect(warnIfEmDashPatchMissing("1.5.0")).toBeNull();
		expect(warnIfEmDashPatchMissing(undefined)).toBeNull();
	});

	test.each(["1.1.5", "1.2.1", "1.3.2", "1.3.9", "1.4.1"])(
		"warns at descriptor time and at plugin init for unpatched %s",
		(version) => {
			let descriptor: ReturnType<typeof dashcommerce> | undefined;
			const atDescriptor = captureWarnings(() => {
				descriptor = dashcommerce({ emdashVersion: version });
			});
			expect(atDescriptor).toContain(`no DashCommerce patch ships for EmDash ${version}`);

			const options = descriptor?.options as { emdashVersion?: string } | undefined;
			expect(options?.emdashVersion).toBe(version);

			const atInit = captureWarnings(() => {
				createPlugin(options);
			});
			expect(atInit).toContain(`no DashCommerce patch ships for EmDash ${version}`);
		},
	);

	test("descriptor auto-detects the installed emdash version and forwards it", async () => {
		const detected = detectEmDashVersionAtBuildTime();
		const resolved = Bun.resolveSync("emdash", import.meta.dir);
		let dir = resolved;
		let installed: string | undefined;
		for (let i = 0; i < 8 && !installed; i++) {
			dir = dir.slice(0, dir.lastIndexOf("/"));
			const file = Bun.file(`${dir}/package.json`);
			if (await file.exists()) {
				const pkg = (await file.json()) as { name?: string; version?: string };
				if (pkg.name === "emdash") installed = pkg.version;
			}
		}
		expect(installed).toBeTruthy();
		expect(detected).toBe(installed ?? null);

		let descriptor: ReturnType<typeof dashcommerce> | undefined;
		captureWarnings(() => {
			descriptor = dashcommerce();
		});
		const options = descriptor?.options as { emdashVersion?: string } | undefined;
		expect(options?.emdashVersion).toBe(installed);
	});
});

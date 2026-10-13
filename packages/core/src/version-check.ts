/**
 * EmDash version compatibility check for DashCommerce.
 *
 * DashCommerce declares a supported EmDash version range and validates at
 * runtime that the installed EmDash version falls within that range.
 * This prevents silent breakage when EmDash is upgraded beyond the tested range.
 */

export interface EmDashVersionRange {
	/** Inclusive lower bound. */
	min: string;
	/** Exclusive upper bound. */
	maxExclusive: string;
}

const EMDASH_037: EmDashVersionRange = { min: "0.37.0", maxExclusive: "0.38.0" };
const EMDASH_1X: EmDashVersionRange = { min: "1.1.0", maxExclusive: "2.0.0" };

/**
 * Supported EmDash version ranges for DashCommerce.
 * Update this when upgrading and testing against newer EmDash versions.
 *
 * Dual range on purpose:
 * - 0.37.x remains supported for existing installs
 * - 1.1.x–1.x is the current EmDash line
 * - 0.38–0.42 and the mistaken `1.0.0` publish are untested / unsafe
 */
export const SUPPORTED_EMDASH_RANGES: readonly EmDashVersionRange[] = [EMDASH_037, EMDASH_1X];

/** npm-style peer string matching {@link SUPPORTED_EMDASH_RANGES}. */
export const SUPPORTED_EMDASH_PEER = ">=0.37.0 <0.38.0 || >=1.1.0 <2.0.0";

/**
 * EmDash versions that ship a matching DashCommerce patch.
 *
 * Patches target hashed dist filenames, so they only apply to that exact
 * version. 1.2.1+ needs a regenerated patch even though the peer range
 * still admits `>=1.1.0 <2.0.0`.
 */
export const EMDASH_VERSIONS_WITH_SHIPPED_PATCHES = ["0.37.0", "1.1.0", "1.2.0"] as const;

/**
 * @deprecated Use {@link SUPPORTED_EMDASH_RANGES}. Kept as the 0.37.x window
 * so older call sites that read `.min` still see the true floor.
 */
export const SUPPORTED_EMDASH_RANGE = {
	min: EMDASH_037.min,
	max: EMDASH_037.maxExclusive,
} as const;

/**
 * Parse a semantic version string into major.minor.patch components.
 */
function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match || !match[1] || !match[2] || !match[3]) return null;
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
	};
}

/**
 * Compare two semantic versions. Returns:
 *  - negative if a < b
 *  - 0 if a === b
 *  - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	const aParsed = parseVersion(a);
	const bParsed = parseVersion(b);

	if (!aParsed || !bParsed) {
		// If we can't parse, fail closed - better to throw than silently run incompatible code
		throw new Error(
			`DashCommerce: Unable to parse version strings for compatibility check. ` +
				`Got: "${a}" vs "${b}". This is a bug, please report it.`,
		);
	}

	if (aParsed.major !== bParsed.major) return aParsed.major - bParsed.major;
	if (aParsed.minor !== bParsed.minor) return aParsed.minor - bParsed.minor;
	return aParsed.patch - bParsed.patch;
}

function isInRange(installedVersion: string, range: EmDashVersionRange): boolean {
	return (
		compareVersions(installedVersion, range.min) >= 0 &&
		compareVersions(installedVersion, range.maxExclusive) < 0
	);
}

export function isEmDashVersionSupported(installedVersion: string): boolean {
	return SUPPORTED_EMDASH_RANGES.some((range) => isInRange(installedVersion, range));
}

export function matchingShippedEmDashPatch(installedVersion: string): string | null {
	const parsed = parseVersion(installedVersion);
	if (!parsed) return null;
	const exact = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
	return (EMDASH_VERSIONS_WITH_SHIPPED_PATCHES as readonly string[]).includes(exact)
		? exact
		: null;
}

/**
 * Warning when the host is in the supported peer range but has no
 * version-exact patch. Null when the version is unsupported (callers
 * should throw) or when a shipped patch matches.
 */
export function emDashPatchMismatchMessage(installedVersion: string): string | null {
	if (!isEmDashVersionSupported(installedVersion)) return null;
	if (matchingShippedEmDashPatch(installedVersion)) return null;
	return (
		`[DashCommerce] EmDash ${installedVersion} is in the supported range, ` +
		`but DashCommerce patches are version-exact (hashed dist filenames). ` +
		`Shipped patches: ${EMDASH_VERSIONS_WITH_SHIPPED_PATCHES.join(", ")}. ` +
		`The 1.2.0 patch will not apply to 1.2.1+. Webhooks and Set-Cookie will fail ` +
		`until you add a matching patch. See packages/core/patches/README.md.`
	);
}

export function formatSupportedEmDashRanges(): string {
	return SUPPORTED_EMDASH_PEER;
}

/**
 * Check if the installed EmDash version is compatible with DashCommerce.
 * Throws a clear error if the version is outside the supported range.
 *
 * @param installedVersion - The installed EmDash version (e.g. from package.json or runtime detection)
 * @throws Error if the version is incompatible
 */
export function checkEmDashVersion(installedVersion: string): void {
	if (isEmDashVersionSupported(installedVersion)) return;

	const floor = EMDASH_037.min;
	if (compareVersions(installedVersion, floor) < 0) {
		throw new Error(
			`[DashCommerce] EmDash version incompatibility detected!\n\n` +
				`Minimum required: ${floor}\n` +
				`Found: ${installedVersion}\n\n` +
				`To upgrade, run:\n` +
				`  npm install emdash@^1.1.0 @emdash-cms/admin@^1.1.0 @dashcommerce/core@^0.2.0\n\n` +
				`Or to stay on the old version:\n` +
				`  npm install @dashcommerce/core@^0.1.5\n` +
				`See https://github.com/emdashCommerce/dashcommerce#migration for details.`,
		);
	}

	throw new Error(
		`[DashCommerce] EmDash version incompatibility detected!\n\n` +
			`Supported versions: ${formatSupportedEmDashRanges()}\n` +
			`Found: ${installedVersion}\n\n` +
			`This version of DashCommerce (@dashcommerce/core@0.2.x) has not been tested with EmDash ${installedVersion}.\n\n` +
			`To fix, upgrade DashCommerce:\n` +
			`  npm install @dashcommerce/core@latest\n\n` +
			`Supported hosts: EmDash 0.37.x, or EmDash 1.1+ (not 1.0.0 — that npm publish is the wrong codebase).\n` +
			`  npm install emdash@^1.1.0 @emdash-cms/admin@^1.1.0\n` +
			`See https://github.com/emdashCommerce/dashcommerce#migration for details.`,
	);
}

/**
 * Detect the EmDash version at build time by importing package.json.
 * This only works in the build context (astro.config.mjs), not in sandbox.
 *
 * @returns The detected EmDash version string, or null if detection fails
 */
export function detectEmDashVersionAtBuildTime(): string | null {
	try {
		// This import works at build time because Node/Bun can resolve package.json
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const emdashPkg = require("emdash/package.json");
		return emdashPkg?.version ?? null;
	} catch {
		return null;
	}
}

/**
 * Validate EmDash compatibility at plugin initialization.
 *
 * This function is called when the plugin is loaded. It will:
 * 1. Use the provided emdashVersion if available (passed from descriptor)
 * 2. If version is detected and out of range: THROW (fail closed for safety)
 * 3. If no version provided: WARN but continue (fail open for compatibility)
 *
 * Fail-open behavior when version is unavailable is necessary because:
 * - Sandboxed plugins cannot detect the version at runtime
 * - We rely on the build-time check in the descriptor
 * - We don't want to break existing working installs
 *
 * The build-time assertion and peer dependencies provide additional safety layers.
 *
 * @param emdashVersion - The EmDash version detected at build time (optional)
 */
export function validateEmDashCompatibility(emdashVersion?: string): void {
	if (!emdashVersion) {
		// No version provided - warn but don't throw
		// This is fail-open behavior for maximum compatibility
		console.warn(
			`[DashCommerce] WARNING: EmDash version not provided to compatibility check.\n` +
				`Ensure EmDash ${formatSupportedEmDashRanges()} is installed.\n` +
				`If you experience issues, verify compatibility: https://github.com/emdashCommerce/dashcommerce#compatibility`,
		);
		return;
	}

	// Version provided - FAIL CLOSED for safety
	try {
		checkEmDashVersion(emdashVersion);
		console.log(`[DashCommerce] ✓ EmDash ${emdashVersion} compatibility verified`);
		const patchWarning = emDashPatchMismatchMessage(emdashVersion);
		if (patchWarning) console.warn(patchWarning);
	} catch (error) {
		// Re-throw with additional context
		if (error instanceof Error) {
			throw error;
		}
		throw new Error(`[DashCommerce] Version compatibility check failed: ${String(error)}`);
	}
}

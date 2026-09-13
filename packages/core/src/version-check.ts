/**
 * EmDash version compatibility check for DashCommerce.
 *
 * DashCommerce declares a supported EmDash version range and validates at
 * runtime that the installed EmDash version falls within that range.
 * This prevents silent breakage when EmDash is upgraded beyond the tested range.
 */

/**
 * Supported EmDash version range for DashCommerce.
 * Update this when upgrading and testing against newer EmDash versions.
 */
export const SUPPORTED_EMDASH_RANGE = {
	min: "0.37.0",
	max: "0.38.0", // exclusive
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

/**
 * Check if the installed EmDash version is compatible with DashCommerce.
 * Throws a clear error if the version is outside the supported range.
 *
 * @param installedVersion - The installed EmDash version (e.g. from package.json or runtime detection)
 * @throws Error if the version is incompatible
 */
export function checkEmDashVersion(installedVersion: string): void {
	const { min, max } = SUPPORTED_EMDASH_RANGE;
	
	// Check if below minimum
	if (compareVersions(installedVersion, min) < 0) {
		throw new Error(
			`[DashCommerce] EmDash version incompatibility detected!\n\n` +
			`Minimum required: ${min}\n` +
			`Found: ${installedVersion}\n\n` +
			`To upgrade, run:\n` +
			`  npm install emdash@^0.37.0 @emdash-cms/admin@^0.37.0 @dashcommerce/core@^0.2.0\n\n` +
			`Or to stay on the old version:\n` +
			`  npm install @dashcommerce/core@^0.1.5\n` +
			`See https://github.com/emdashCommerce/dashcommerce#migration for details.`,
		);
	}
	
	// Check if at or above maximum (exclusive)
	if (compareVersions(installedVersion, max) >= 0) {
		throw new Error(
			`[DashCommerce] EmDash version incompatibility detected!\n\n` +
			`Supported versions: ${min} - ${max} (exclusive)\n` +
			`Found: ${installedVersion}\n\n` +
			`This version of DashCommerce (@dashcommerce/core@0.2.x) has not been tested with EmDash ${installedVersion}.\n\n` +
			`To fix, upgrade DashCommerce:\n` +
			`  npm install @dashcommerce/core@latest\n\n` +
			`If no compatible version is available, stay on EmDash 0.37.x:\n` +
			`  npm install emdash@^0.37.0 @emdash-cms/admin@^0.37.0\n` +
			`See https://github.com/emdashCommerce/dashcommerce#migration for details.`,
		);
	}
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
			`Ensure EmDash ${SUPPORTED_EMDASH_RANGE.min} - ${SUPPORTED_EMDASH_RANGE.max} is installed.\n` +
			`If you experience issues, verify compatibility: https://github.com/emdashCommerce/dashcommerce#compatibility`,
		);
		return;
	}
	
	// Version provided - FAIL CLOSED for safety
	try {
		checkEmDashVersion(emdashVersion);
		console.log(`[DashCommerce] ✓ EmDash ${emdashVersion} compatibility verified`);
	} catch (error) {
		// Re-throw with additional context
		if (error instanceof Error) {
			throw error;
		}
		throw new Error(`[DashCommerce] Version compatibility check failed: ${String(error)}`);
	}
}

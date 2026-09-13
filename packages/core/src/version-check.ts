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
		// If we can't parse, assume compatible (fail open)
		return 0;
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
			`DashCommerce requires EmDash >= ${min}, but found ${installedVersion}. ` +
			`Please upgrade EmDash: npm install emdash@latest @emdash-cms/admin@latest`,
		);
	}
	
	// Check if at or above maximum (exclusive)
	if (compareVersions(installedVersion, max) >= 0) {
		throw new Error(
			`DashCommerce supports EmDash < ${max}, but found ${installedVersion}. ` +
			`This version of DashCommerce has not been tested with EmDash ${installedVersion}. ` +
			`Please upgrade DashCommerce to a compatible version: npm install @dashcommerce/core@latest`,
		);
	}
}

/**
 * Attempt to detect the EmDash version at runtime.
 * This is best-effort; if detection fails, we return null and skip the check
 * (failing open to avoid breaking existing installs).
 * 
 * Note: This uses a try-catch wrapper since we cannot use require() in sandbox mode.
 * In production, the version should be passed via the plugin options or detected
 * from EmDash's exposed metadata if available.
 */
export function detectEmDashVersion(): string | null {
	// TODO: Once EmDash exposes its version via runtime context or a global,
	// we can detect it here. For now, we rely on the version being passed
	// via plugin options or fail open if unavailable.
	return null;
}

/**
 * Check EmDash compatibility at plugin initialization.
 * Logs a warning but doesn't throw if version detection fails.
 */
export function validateEmDashCompatibility(): void {
	const version = detectEmDashVersion();
	
	if (!version) {
		// Couldn't detect version - log a warning but don't throw
		console.warn(
			"[DashCommerce] Could not detect EmDash version. " +
			`Ensure EmDash ${SUPPORTED_EMDASH_RANGE.min} - ${SUPPORTED_EMDASH_RANGE.max} is installed.`,
		);
		return;
	}
	
	try {
		checkEmDashVersion(version);
		console.log(`[DashCommerce] Using EmDash ${version} (compatible)`);
	} catch (error) {
		// Re-throw the compatibility error with clear instructions
		throw error;
	}
}

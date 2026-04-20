import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	dts: true,
	clean: true,
	sourcemap: true,
	platform: "node",
	// Prepend a node shebang so the built file is directly executable when npm
	// links it as a bin script.
	banner: {
		js: "#!/usr/bin/env node",
	},
	external: [
		// Keep dependencies external — this is a CLI, not a bundle. The user's
		// runtime resolver will pull them in at install time.
		"giget",
		"prompts",
		"picocolors",
		/^node:/,
	],
});

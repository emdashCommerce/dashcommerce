import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/sandbox-entry.ts",
		"src/admin/entry.tsx",
		// NOTE: src/astro/index.ts is NOT bundled — it imports `.astro`
		// components that rolldown can't compile. We ship it as source and
		// let the host's Astro build resolve the imports (see package.json
		// `./astro` export → `./src/astro/index.ts`).
	],
	format: "esm",
	dts: true,
	clean: true,
	sourcemap: true,
	external: ["emdash", "react", "react-dom", "@emdash-cms/admin", "astro", "@stripe/stripe-js", "@stripe/react-stripe-js"],
	// Sandbox-entry must remain sandbox-compatible — no Node built-ins.
	platform: "neutral",
});

/**
 * Ambient declaration for `.astro` imports.
 *
 * tsdown + rolldown can't compile Astro components, so we ship
 * `src/astro/index.ts` as source. TypeScript needs to know that `.astro`
 * modules exist and export a component-like default.
 */

declare module "*.astro" {
	import type { ComponentType } from "react";
	const Component: ComponentType<Record<string, unknown>>;
	export default Component;
}

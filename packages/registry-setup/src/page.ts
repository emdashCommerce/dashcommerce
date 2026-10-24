import type { BlockResponse } from "@emdash-cms/blocks/server";

/**
 * The DashCommerce setup page, as a Block Kit response. Plain data, no I/O.
 * Install steps follow the repo README and packages/core/patches/README.md.
 */

export const LINKS = {
	docs: "https://dashcommerce.dev/docs",
	gettingStarted: "https://dashcommerce.dev/docs/getting-started",
	stripe: "https://dashcommerce.dev/docs/stripe",
	demo: "https://demo.dashcommerce.dev",
	repo: "https://github.com/emdashCommerce/dashcommerce",
	patches:
		"https://github.com/emdashCommerce/dashcommerce/blob/main/packages/core/patches/README.md",
	npm: "https://www.npmjs.com/package/@dashcommerce/core",
} as const;

const ASTRO_CONFIG = `// astro.config.mjs
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { dashcommerce } from "@dashcommerce/core";

export default defineConfig({
  integrations: [
    emdash({
      // keep your existing database, storage and other options
      plugins: [dashcommerce()],
    }),
  ],
});`;

const BUN_PATCH = `// package.json (Bun). Keep only the line for your installed EmDash version.
{
  "patchedDependencies": {
    "emdash@0.37.0": "node_modules/@dashcommerce/core/patches/emdash@0.37.0.patch",
    "emdash@1.1.0": "node_modules/@dashcommerce/core/patches/emdash@1.1.0.patch",
    "emdash@1.2.0": "node_modules/@dashcommerce/core/patches/emdash@1.2.0.patch",
    "emdash@1.3.0": "node_modules/@dashcommerce/core/patches/emdash@1.3.0.patch",
    "emdash@1.3.1": "node_modules/@dashcommerce/core/patches/emdash@1.3.1.patch"
  }
}`;

const NPM_PATCH = `npm install -D patch-package
mkdir -p patches
# copy the file that matches your installed EmDash version, for example 1.3.1:
cp node_modules/@dashcommerce/core/patches/emdash@1.3.1.patch patches/
# add "postinstall": "patch-package" to your package.json scripts, then:
npm install`;

const NODE_EXTERNALS = `// astro.config.mjs, Node.js builds only
export default defineConfig({
  // ...
  vite: {
    build: {
      rollupOptions: {
        external: [/^cloudflare:/],
      },
    },
  },
});`;

const SEED = `npx dashcommerce-merge-seed
npx emdash seed --on-conflict=update`;

export function renderSetupPage(): BlockResponse {
	return {
		blocks: [
			{ type: "header", text: "DashCommerce setup" },
			{
				type: "banner",
				title: "This is a setup guide",
				description:
					"Installing this entry from the registry adds this page and nothing else. The DashCommerce store is a native EmDash plugin: you install it from npm as @dashcommerce/core, register it in astro.config.mjs, and redeploy. The steps are below.",
			},
			{
				type: "section",
				text: "DashCommerce is an MIT licensed commerce plugin for EmDash. It adds products (simple, variable, subscription and digital), a cart, Stripe checkout, orders with refunds, coupons, shipping zones, tax, inventory, reviews, subscriptions, and multi-vendor payouts through Stripe Connect. It runs on Cloudflare Workers or Node.js and adds its own pages to the EmDash admin.",
			},
			{
				type: "fields",
				fields: [
					{ label: "npm package", value: "@dashcommerce/core" },
					{ label: "EmDash versions DashCommerce supports", value: "0.37.x, or 1.1.0 to 1.3.x" },
					{ label: "Hosting", value: "Cloudflare Workers or Node.js" },
					{ label: "Payments", value: "Stripe (test mode works out of the box)" },
				],
			},
			{
				type: "actions",
				elements: [
					{
						type: "link",
						label: "Documentation",
						target: { kind: "external", url: LINKS.docs },
						appearance: "primary",
					},
					{
						type: "link",
						label: "Live demo",
						target: { kind: "external", url: LINKS.demo },
						appearance: "secondary",
					},
					{
						type: "link",
						label: "GitHub repository",
						target: { kind: "external", url: LINKS.repo },
						appearance: "secondary",
					},
					{
						type: "link",
						label: "npm package",
						target: { kind: "external", url: LINKS.npm },
						appearance: "secondary",
					},
				],
			},
			{ type: "divider" },
			{ type: "header", text: "Starting a new site" },
			{
				type: "section",
				text: "The quickest route is the starter. It creates an Astro site with EmDash, DashCommerce, six demo products and Stripe test mode already wired up.",
			},
			{ type: "code", language: "bash", code: "npm create @dashcommerce@latest" },
			{ type: "divider" },
			{ type: "header", text: "Adding DashCommerce to an existing EmDash site" },
			{ type: "section", text: "1. Install the package in your site project." },
			{ type: "code", language: "bash", code: "npm install @dashcommerce/core" },
			{ type: "section", text: "2. Register the plugin in astro.config.mjs." },
			{ type: "code", language: "ts", code: ASTRO_CONFIG },
			{
				type: "section",
				text: "3. Apply the EmDash patch for your exact EmDash version. DashCommerce needs it for Stripe webhook signatures, cart cookies and redirects. Patches ship for EmDash 0.37.0, 1.1.0, 1.2.0, 1.3.0 and 1.3.1, and each one only applies to that exact version. Check your version with npm ls emdash.",
			},
			{ type: "code", language: "jsonc", code: BUN_PATCH },
			{ type: "context", text: "With Bun, run bun install after editing package.json." },
			{ type: "code", language: "bash", code: NPM_PATCH },
			{
				type: "context",
				text: "With npm or Yarn, use patch-package. pnpm uses the same patchedDependencies map under the pnpm key.",
			},
			{
				type: "actions",
				elements: [
					{
						type: "link",
						label: "Patch instructions",
						target: { kind: "external", url: LINKS.patches },
						appearance: "secondary",
					},
				],
			},
			{
				type: "section",
				text: "4. If you build for Node.js, mark cloudflare: imports as external in the Vite config. Cloudflare Workers builds do not need this.",
			},
			{ type: "code", language: "ts", code: NODE_EXTERNALS },
			{
				type: "section",
				text: "5. Add the products collection and taxonomies to your seed, then apply it. Add --with-demo-catalog to the first command if you want six sample products.",
			},
			{ type: "code", language: "bash", code: SEED },
			{
				type: "section",
				text: "6. Restart or redeploy the site. Open the DashCommerce settings page in the admin and paste your Stripe test keys.",
			},
			{
				type: "actions",
				elements: [
					{
						type: "link",
						label: "Getting started guide",
						target: { kind: "external", url: LINKS.gettingStarted },
						appearance: "primary",
					},
					{
						type: "link",
						label: "Stripe setup",
						target: { kind: "external", url: LINKS.stripe },
						appearance: "secondary",
					},
				],
			},
			{ type: "divider" },
			{
				type: "section",
				text: "A sandboxed option with no npm step, DashCommerce Lite, is available in the EmDash plugin registry (slug dashcommerce-lite). Full DashCommerce stays on npm as @dashcommerce/core. Don't install Lite alongside core.",
			},
			{
				type: "context",
				text: "This page asks for no permissions and makes no network requests, and you can uninstall it once your store is running.",
			},
		],
	};
}

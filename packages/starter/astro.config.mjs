import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { dashcommerce } from "@dashcommerce/core";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { defineConfig, envField, passthroughImageService } from "astro/config";
import emdash, { local, s3 } from "emdash/astro";
import { postgres, sqlite } from "emdash/db";

// Three deploy targets share this config:
//   - Local dev (default): SQLite file + local uploads
//   - Node prod (Railway): Postgres via DATABASE_URL + S3/R2 via S3_* env vars
//   - Cloudflare Workers: D1 binding + R2 binding, selected by DEPLOY_TARGET=cloudflare
const target = process.env.DEPLOY_TARGET === "cloudflare" ? "cloudflare" : "node";

// Storefront edition. "native" (default) registers @dashcommerce/core.
// "sandboxed" leaves core out so DashCommerce can be installed from the
// EmDash plugin registry instead (both use the plugin id "dashcommerce", so
// only one can be active), and the pages switch to the storefront kit in
// src/lib/dashcommerce.js. See README.md, "Sandboxed edition".
const edition =
	process.env.DASHCOMMERCE_EDITION === "sandboxed" ? "sandboxed" : "native";

const adapter =
	target === "cloudflare" ? cloudflare() : node({ mode: "standalone" });

const database =
	target === "cloudflare"
		? d1({ binding: "DB" })
		: process.env.DATABASE_URL
			? postgres({
					connectionString: process.env.DATABASE_URL,
					ssl: true,
				})
			: sqlite({ url: process.env.SQLITE_URL ?? "file:./data.db" });

const storage =
	target === "cloudflare"
		? r2({ binding: "MEDIA", publicUrl: process.env.R2_PUBLIC_URL })
		: process.env.S3_BUCKET
			? s3()
			: local({
					directory: "./uploads",
					baseUrl: "/_emdash/api/media/file",
				});

export default defineConfig({
	// Override this with the real production site origin before shipping
	// so absolute sitemap URLs are correct.
	site: process.env.SITE_URL ?? "http://localhost:4321",
	output: "server",
	adapter,
	image: {
		layout: "constrained",
		responsiveStyles: true,
		// sharp (Astro's default) is Node-only; Workers uses the passthrough service.
		...(target === "cloudflare" ? { service: passthroughImageService() } : {}),
	},
	env: {
		schema: {
			DASHCOMMERCE_EDITION: envField.enum({
				context: "server",
				access: "public",
				values: ["native", "sandboxed"],
				default: "native",
			}),
		},
	},
	integrations: [
		react(),
		sitemap({
			// Admin + post-checkout pages shouldn't be crawled.
			filter: (page) =>
				!page.includes("/_emdash/") &&
				!page.includes("/thank-you/") &&
				!page.includes("/account") &&
				!page.includes("/subscriptions/"),
		}),
		emdash({
			database,
			storage,
			plugins: edition === "native" ? [dashcommerce()] : [],
			// Registry installs need a sandbox runner. On Cloudflare this is
			// the Worker Loader runner, which needs the LOADER binding in
			// wrangler.jsonc (paid plan); without it sandbox() returns
			// undefined and registry installs stay off.
			...(edition === "sandboxed" && target === "cloudflare"
				? { sandboxRunner: sandbox() }
				: {}),
		}),
	],
	devToolbar: { enabled: false },
	vite: {
		build: {
			rollupOptions: {
				// Externalize Cloudflare Workers runtime modules when building for Node.
				// EmDash 0.37.0+ imports these conditionally, but Vite tries to bundle them
				// during the build step, causing resolution errors. These are only available
				// in the Cloudflare Workers runtime and should be treated as external.
				external: target === "node" ? [
					"cloudflare:sockets",
					"cloudflare:email",
					/^cloudflare:/,
				] : [],
			},
		},
	},
});

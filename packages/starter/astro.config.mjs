import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { dashcommerce } from "@dashcommerce/core";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig, passthroughImageService } from "astro/config";
import emdash, { local, s3 } from "emdash/astro";
import { postgres, sqlite } from "emdash/db";

// Three deploy targets share this config:
//   - Local dev (default): SQLite file + local uploads
//   - Node prod (Railway): Postgres via DATABASE_URL + S3/R2 via S3_* env vars
//   - Cloudflare Workers: D1 binding + R2 binding, selected by DEPLOY_TARGET=cloudflare
const target = process.env.DEPLOY_TARGET === "cloudflare" ? "cloudflare" : "node";

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
			plugins: [dashcommerce()],
		}),
	],
	devToolbar: { enabled: false },
});

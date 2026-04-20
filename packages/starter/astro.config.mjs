import node from "@astrojs/node";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import emdash, { local, s3 } from "emdash/astro";
import { postgres, sqlite } from "emdash/db";
import { dashcommerce } from "@dashcommerce/core";

// In production (Railway), DATABASE_URL points at Neon and S3_* env vars point
// at R2. Locally, fall back to the bundled SQLite file + uploads dir so
// `bun run dev` works with no env setup.
const database = process.env.DATABASE_URL
	? postgres({ connectionString: process.env.DATABASE_URL, ssl: true })
	: sqlite({ url: "file:./data.db" });

const storage = process.env.S3_BUCKET
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
	adapter: node({ mode: "standalone" }),
	image: {
		layout: "constrained",
		responsiveStyles: true,
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

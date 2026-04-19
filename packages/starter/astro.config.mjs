import node from "@astrojs/node";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { dashcommerce } from "@dashcommerce/core";

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
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
			plugins: [dashcommerce()],
		}),
	],
	devToolbar: { enabled: false },
});

/**
 * DashCommerce — site-side component registry.
 *
 * Exported via `"./astro"` and consumed by the host at build time via
 * the plugin descriptor's `componentsEntry`. The host's Astro compiler
 * resolves the `.astro` imports below and wires each block type into
 * its <PortableText> renderer.
 *
 * This module must ship as source (not bundled) because rolldown/tsdown
 * can't compile `.astro` files — Astro's compiler lives in the consumer
 * project, not in our build pipeline.
 */

import ProductEmbedBlock from "./components/ProductEmbedBlock.astro";
import ProductGridBlock from "./components/ProductGridBlock.astro";
import ReviewQuoteBlock from "./components/ReviewQuoteBlock.astro";

export const blockComponents = {
	"product-embed": ProductEmbedBlock,
	"product-grid": ProductGridBlock,
	"review-quote": ReviewQuoteBlock,
};

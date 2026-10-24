/**
 * Which DashCommerce edition the storefront talks to.
 *
 * - "native" (default): `@dashcommerce/core` is registered in
 *   astro.config.mjs and the pages use core's Astro components.
 * - "sandboxed": core is not registered. The site installs DashCommerce from
 *   the EmDash plugin registry, and the pages use the storefront kit in
 *   src/lib/dashcommerce.js and src/components/{AddToCart,CartCount,Cart,
 *   CheckoutSuccess}.astro.
 *
 * Set DASHCOMMERCE_EDITION=sandboxed at build time to switch.
 */
import { DASHCOMMERCE_EDITION } from "astro:env/server";

export const SANDBOXED = DASHCOMMERCE_EDITION === "sandboxed";

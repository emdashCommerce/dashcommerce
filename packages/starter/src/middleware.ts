/**
 * Runtime registration of extra payment providers (FIK-57 test wiring).
 *
 * The server loads middleware before it serves any request, including
 * DashCommerce's plugin routes, so importing a gateway package here puts
 * it in core's provider registry before a webhook can arrive. Importing it
 * in astro.config.mjs would not: that file runs only at build time.
 */
import "@dashcommerce/paystack";
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware((_context, next) => next());

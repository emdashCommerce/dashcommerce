# DashCommerce Setup

A setup guide for [DashCommerce](https://dashcommerce.dev), packaged as a sandboxed EmDash plugin so it can be listed in the EmDash plugin registry.

The DashCommerce store itself is a native EmDash plugin. Install it from npm as [`@dashcommerce/core`](https://www.npmjs.com/package/@dashcommerce/core) and register it in `astro.config.mjs`. This plugin only adds one admin page with those install steps and links to the docs, the [demo](https://demo.dashcommerce.dev) and the [source](https://github.com/emdashCommerce/dashcommerce).

It asks for no capabilities, no network hosts and no storage.

A sandboxed option with no npm step, DashCommerce Lite, is available in the EmDash plugin registry (slug `dashcommerce-lite`). Full DashCommerce stays on npm as `@dashcommerce/core`. Don't install Lite alongside core.

License: MIT.

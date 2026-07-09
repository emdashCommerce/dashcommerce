// Cloudflare Worker entry.
//
// Astro's @astrojs/cloudflare adapter generates a fetch-only Worker. EmDash's
// background work — plugin cron (DashCommerce's abandoned-cart recovery, dunning
// retries, and stock-lock sweeps), scheduled publishing, and system cleanup — is
// driven by a `scheduled()` handler, NOT by request side effects (emdash 0.19+).
//
// `@emdash-cms/cloudflare/worker` wraps the adapter's server handler with that
// `scheduled()` handler. The Cron Trigger in wrangler.jsonc (`triggers.crons`)
// invokes it once a minute. Without this entry + trigger, DashCommerce's cron
// jobs silently never run on Cloudflare.
//
// `PluginBridge` is the sandbox Durable Object, re-exported so its binding
// resolves if sandboxed plugins are ever added (none are wired by default).
export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";

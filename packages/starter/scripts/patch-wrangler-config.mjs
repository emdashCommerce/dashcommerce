#!/usr/bin/env node
/**
 * Patch dist/server/wrangler.json with deployer-supplied binding ids.
 *
 * Why: wrangler.jsonc at the repo root ships without D1/KV ids so the starter
 * stays multi-tenant (each deployer brings their own Cloudflare account). The
 * Astro adapter copies the bindings as-is into dist/server/wrangler.json at
 * build time. Without ids, `wrangler deploy` fails at the API layer with
 * "binding X must have a valid id specified".
 *
 * This script reads the ids from env vars at deploy time and writes them into
 * the generated config before `wrangler deploy` reads it.
 *
 * Expected env vars (set them on the Cloudflare Worker project):
 *   CF_D1_DATABASE_ID  — UUID from `wrangler d1 create <name>`
 *   CF_KV_SESSION_ID   — id from `wrangler kv namespace create SESSION`
 *   CF_R2_BUCKET       — optional override; defaults to wrangler.jsonc value
 *   CF_R2_PUBLIC_URL   — optional override; defaults to wrangler.jsonc value
 *
 * Runs as part of `build:cf`, so `wrangler deploy --config dist/server/wrangler.json`
 * always sees a fully-resolved config.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CONFIG_PATH = "dist/server/wrangler.json";

if (!existsSync(CONFIG_PATH)) {
	console.error(
		`[patch-wrangler] ${CONFIG_PATH} not found — run \`astro build\` with DEPLOY_TARGET=cloudflare first.`,
	);
	process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const patches = [];

const d1Id = process.env.CF_D1_DATABASE_ID;
if (d1Id && Array.isArray(config.d1_databases)) {
	for (const db of config.d1_databases) {
		if (db.binding === "DB") {
			db.database_id = d1Id;
			patches.push(`d1.DB.database_id = ${d1Id.slice(0, 8)}…`);
		}
	}
}

const kvId = process.env.CF_KV_SESSION_ID;
if (kvId && Array.isArray(config.kv_namespaces)) {
	for (const ns of config.kv_namespaces) {
		if (ns.binding === "SESSION") {
			ns.id = kvId;
			patches.push(`kv.SESSION.id = ${kvId.slice(0, 8)}…`);
		}
	}
}

const r2Bucket = process.env.CF_R2_BUCKET;
if (r2Bucket && Array.isArray(config.r2_buckets)) {
	for (const b of config.r2_buckets) {
		if (b.binding === "MEDIA") {
			b.bucket_name = r2Bucket;
			patches.push(`r2.MEDIA.bucket_name = ${r2Bucket}`);
		}
	}
}

const r2PublicUrl = process.env.CF_R2_PUBLIC_URL;
if (r2PublicUrl) {
	// Baked into the bundle at build time via astro.config.mjs. Only informs
	// the log — no config field to patch here since the value is already frozen
	// into emitted JS at this point.
	patches.push(`r2.publicUrl = ${r2PublicUrl} (compiled in)`);
}

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n");

if (patches.length === 0) {
	console.warn(
		"[patch-wrangler] No binding env vars set — deploy will likely fail with 'must have a valid id specified'. Set CF_D1_DATABASE_ID and CF_KV_SESSION_ID on the Worker project.",
	);
} else {
	console.log(`[patch-wrangler] Patched: ${patches.join(", ")}`);
}

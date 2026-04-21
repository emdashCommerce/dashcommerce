#!/usr/bin/env node
/**
 * Orchestrate the full "seed D1 from local SQLite" flow without requiring
 * the deployer to hand-edit wrangler.jsonc.
 *
 * Flow:
 *   1. Bootstrap local SQLite (schema + seed + demo catalog)
 *   2. Produce a D1-safe SQL dump (strips FTS5 + sqlite_schema writes)
 *   3. Temporarily patch wrangler.jsonc's placeholder with the deployer's
 *      real database_id (from CF_D1_DATABASE_ID env var), run `wrangler d1`
 *      commands, then restore the template.
 *   4. Drop existing tables on D1 (avoids PK collisions on rerun)
 *   5. Import the dump
 *
 * Usage:
 *   CF_D1_DATABASE_ID=<uuid> bun run cf:d1:seed
 *
 * The template wrangler.jsonc stays committed with the REPLACE_AFTER… placeholder
 * so the starter remains multi-tenant — each deployer brings their own ids.
 */

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

const WRANGLER = "wrangler.jsonc";
const BACKUP = "wrangler.jsonc.bak";
const PLACEHOLDER = "REPLACE_AFTER_WRANGLER_D1_CREATE";
const DB_NAME = "dashcommerce-demo";

const dbId = process.env.CF_D1_DATABASE_ID;
if (!dbId) {
	console.error(`
[cf-d1-seed] CF_D1_DATABASE_ID env var is required.

Create a D1 database and export its id:
  wrangler d1 create ${DB_NAME}
  export CF_D1_DATABASE_ID=<uuid-from-output>
  bun run cf:d1:seed
`);
	process.exit(1);
}

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, {
		stdio: "inherit",
		...options,
	});
	if (result.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(" ")} exited with status ${result.status}`,
		);
	}
	return result;
}

function capture(cmd, args) {
	const result = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
	if (result.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(" ")} exited with status ${result.status}`,
		);
	}
	return result.stdout.toString();
}

function restoreWrangler() {
	if (existsSync(BACKUP)) {
		copyFileSync(BACKUP, WRANGLER);
		unlinkSync(BACKUP);
	}
}

process.on("SIGINT", () => {
	restoreWrangler();
	process.exit(130);
});

try {
	console.log("→ Bootstrapping local SQLite...");
	run("bun", ["run", "bootstrap"]);

	console.log("→ Generating D1-safe SQL dump...");
	run("node", ["scripts/cf-d1-dump.mjs"]);

	console.log("→ Patching wrangler.jsonc with real D1 id (temporary)...");
	copyFileSync(WRANGLER, BACKUP);
	const contents = readFileSync(WRANGLER, "utf8");
	if (!contents.includes(PLACEHOLDER)) {
		console.warn(
			`[cf-d1-seed] ${WRANGLER} doesn't contain the expected placeholder "${PLACEHOLDER}". Carrying on with the file as-is.`,
		);
	}
	writeFileSync(WRANGLER, contents.replaceAll(PLACEHOLDER, dbId));

	console.log("→ Dropping existing tables on D1...");
	const listJson = capture("wrangler", [
		"d1",
		"execute",
		DB_NAME,
		"--remote",
		"--json",
		"--command",
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
	]);
	const tables = Array.from(listJson.matchAll(/"name"\s*:\s*"([^"]+)"/g)).map(
		(m) => m[1],
	);
	for (const t of tables) {
		run("wrangler", [
			"d1",
			"execute",
			DB_NAME,
			"--remote",
			"--command",
			`DROP TABLE IF EXISTS "${t}"`,
		]);
	}

	console.log("→ Applying dump to D1...");
	run("wrangler", [
		"d1",
		"execute",
		DB_NAME,
		"--remote",
		"--file",
		".emdash/d1-seed.sql",
	]);

	console.log("\n✓ D1 seeded. Tables now live:");
	run("wrangler", [
		"d1",
		"execute",
		DB_NAME,
		"--remote",
		"--command",
		"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
	]);
} catch (err) {
	console.error(`\n[cf-d1-seed] ${err.message}`);
	process.exitCode = 1;
} finally {
	restoreWrangler();
}

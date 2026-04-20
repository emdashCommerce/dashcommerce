#!/usr/bin/env node
/**
 * Produce a D1-safe SQL dump from local data.db.
 *
 * Why a dedicated script (not just sqlite3 .dump | grep):
 * - SQLite's `.dump` represents FTS5 virtual tables as INSERT INTO sqlite_schema(...).
 *   D1 rejects any write to sqlite_schema/sqlite_master with "table sqlite_master
 *   may not be modified", so those statements must go.
 * - FTS5 triggers that live on the host tables (e.g. _emdash_fts_products_insert)
 *   also write into the virtual tables' shadow storage. Once we drop the FTS5
 *   tables, those triggers become broken — cleanest to drop them too.
 * - We do all of this on a *copy* of data.db so local dev + search keep working.
 *
 * Trade-off: full-text search won't work on the D1 deploy until emdash's D1
 * adapter learns to materialize FTS5 indexes itself. Everything else (products,
 * checkout, admin, blog) lands intact.
 */

import {
	copyFileSync,
	existsSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";

const SRC = "data.db";
const COPY = "/tmp/dashcommerce-d1-export.db";
const OUT = ".emdash/d1-seed.sql";

if (!existsSync(SRC)) {
	console.error(
		`[cf-d1-dump] ${SRC} not found. Run \`bun run bootstrap\` first.`,
	);
	process.exit(1);
}

if (existsSync(COPY)) unlinkSync(COPY);
copyFileSync(SRC, COPY);

function sqlite(cmd) {
	return execFileSync("sqlite3", [COPY, cmd]).toString();
}

const ftsTables = sqlite(
	"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_emdash_fts%' ORDER BY name",
)
	.trim()
	.split(/\r?\n/)
	.filter(Boolean);

for (const t of ftsTables) {
	sqlite(`DROP TABLE IF EXISTS "${t}"`);
}

const ftsTriggers = sqlite(
	"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '_emdash_fts%' ORDER BY name",
)
	.trim()
	.split(/\r?\n/)
	.filter(Boolean);

for (const t of ftsTriggers) {
	sqlite(`DROP TRIGGER IF EXISTS "${t}"`);
}

const raw = execFileSync("sqlite3", [COPY, ".dump"]).toString();

// D1 rejects: header PRAGMAs, explicit transactions, CREATE TABLE on sqlite_*,
// any INSERT into sqlite_schema (the dump's representation of virtual tables).
const safe = raw
	.split("\n")
	.filter((line) => !/^(PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/.test(line))
	.filter((line) => !/^CREATE TABLE\s+"?sqlite_/.test(line))
	.filter((line) => !/^INSERT INTO\s+"?sqlite_/.test(line))
	.join("\n");

writeFileSync(OUT, safe);
unlinkSync(COPY);

console.log(
	`[cf-d1-dump] wrote ${OUT} — stripped ${ftsTables.length} FTS5 tables, ${ftsTriggers.length} FTS5 triggers`,
);

/**
 * Fails when the registry bundle exceeds the caps from RFC 0001:
 * 128 KB per file and 256 KB total, decompressed. `emdash-plugin bundle`
 * enforces the same caps; this script prints the numbers and also keeps a
 * tighter budget for backend.js so growth is noticed early.
 *
 * Usage: bun run bundle && bun run size
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const KB = 1024;
const PER_FILE = 128 * KB;
const TOTAL = 256 * KB;
const BACKEND_BUDGET = 96 * KB;

const dist = join(import.meta.dir, "..", "dist");
const tarball = readdirSync(dist).find((f) => f.endsWith(".tar.gz"));
if (!tarball) {
	console.error("No tarball in dist/. Run `bun run bundle` first.");
	process.exit(1);
}

// Minimal tar reader: 512-byte headers, size in octal at offset 124.
const tar = gunzipSync(readFileSync(join(dist, tarball)));
const files: Array<{ name: string; size: number }> = [];
for (let off = 0; off + 512 <= tar.length; ) {
	const name = tar
		.subarray(off, off + 100)
		.toString("utf8")
		.replace(/\0.*$/s, "");
	if (!name) break;
	const size = Number.parseInt(
		tar
			.subarray(off + 124, off + 136)
			.toString("utf8")
			.replace(/\0.*$/s, "")
			.trim() || "0",
		8,
	);
	files.push({ name, size });
	off += 512 + Math.ceil(size / 512) * 512;
}

let total = 0;
let failed = false;
for (const f of files) {
	total += f.size;
	const over = f.size > PER_FILE;
	failed ||= over;
	console.log(
		`${(f.size / KB).toFixed(1).padStart(7)} KB  ${f.name}${over ? "  OVER 128 KB" : ""}`,
	);
}
console.log(
	`${(total / KB).toFixed(1).padStart(7)} KB  total (cap 256 KB), tarball ${(statSync(join(dist, tarball)).size / KB).toFixed(1)} KB gzipped`,
);
if (total > TOTAL) failed = true;
const backend = files.find((f) => f.name === "backend.js");
if (!backend) failed = true;
else if (backend.size > BACKEND_BUDGET) {
	console.error(`backend.js is over the ${BACKEND_BUDGET / KB} KB working budget`);
	failed = true;
}
process.exit(failed ? 1 : 0);

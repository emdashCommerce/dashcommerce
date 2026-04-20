#!/usr/bin/env node
/**
 * CLI: merge DashCommerce `products` collection + product taxonomies into the host seed file.
 *
 * @see package.json `bin` → `dashcommerce-merge-seed`
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { mergeDashCommerceSeed } from "../seed/merge-dashcommerce-seed";

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

interface PackageJson {
	emdash?: { seed?: string };
}

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
	try {
		const raw = await readFile(resolve(cwd, "package.json"), "utf-8");
		return JSON.parse(raw) as PackageJson;
	} catch {
		return null;
	}
}

/**
 * Match `emdash seed` resolution when no positional path is given:
 * `.emdash/seed.json` if it exists, else `package.json` → `emdash.seed`.
 * If neither yields a path, default to `.emdash/seed.json` (file may be created).
 */
export async function resolveSeedPathForMerge(cwd: string, flagPath?: string): Promise<string> {
	if (flagPath) {
		return resolve(cwd, flagPath);
	}
	const convention = resolve(cwd, ".emdash", "seed.json");
	if (await fileExists(convention)) {
		return convention;
	}
	const pkg = await readPackageJson(cwd);
	if (pkg?.emdash?.seed) {
		return resolve(cwd, pkg.emdash.seed);
	}
	return convention;
}

function printHelp(): void {
	console.log(`dashcommerce-merge-seed — merge DashCommerce collection + taxonomies into seed.json

Usage:
  dashcommerce-merge-seed [options]

Options:
  --seed <path>         Seed file path (relative to cwd). Default: same resolution as \`emdash seed\`
  --cwd <dir>           Working directory (default: process.cwd())
  --with-demo-catalog   Also append 6 demo products (one per product type) plus
                        curated product_category / product_tag terms. Idempotent —
                        existing products with matching ids are preserved.
  -h, --help            Show this message

Writes a pretty-printed JSON file. Preserves unrelated keys (settings, content, menus, …).
Collections are deduped by collection slug; taxonomies by taxonomy name.
`);
}

function parseArgs(argv: string[]): {
	seed?: string;
	cwd: string;
	help: boolean;
	withDemoCatalog: boolean;
} {
	let seed: string | undefined;
	let cwd = process.cwd();
	let help = false;
	let withDemoCatalog = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) {
			continue;
		}
		if (a === "-h" || a === "--help") {
			help = true;
			continue;
		}
		if (a === "--seed") {
			const next = argv[++i];
			if (next) {
				seed = next;
			}
			continue;
		}
		if (a === "--cwd") {
			const next = argv[++i];
			if (next) {
				cwd = resolve(next);
			}
			continue;
		}
		if (a === "--with-demo-catalog") {
			withDemoCatalog = true;
			continue;
		}
		if (a.startsWith("-")) {
			console.error(`Unknown option: ${a}`);
			process.exit(1);
		}
	}
	return { seed, cwd, help, withDemoCatalog };
}

async function main(): Promise<void> {
	const { seed: seedFlag, cwd, help, withDemoCatalog } = parseArgs(process.argv.slice(2));
	if (help) {
		printHelp();
		process.exit(0);
	}

	const target = await resolveSeedPathForMerge(cwd, seedFlag);
	const dir = dirname(target);
	if (!(await fileExists(dir))) {
		await mkdir(dir, { recursive: true });
	}

	let base: Record<string, unknown> = {};
	if (await fileExists(target)) {
		try {
			const raw = await readFile(target, "utf-8");
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				base = parsed as Record<string, unknown>;
			} else {
				console.error(`Invalid seed file (expected JSON object): ${target}`);
				process.exit(1);
			}
		} catch (e) {
			console.error(`Failed to read or parse seed file: ${target}`, e);
			process.exit(1);
		}
	}

	const merged = mergeDashCommerceSeed(base, { withDemoCatalog });
	const out = `${JSON.stringify(merged, null, "\t")}\n`;
	await writeFile(target, out, "utf-8");
	const suffix = withDemoCatalog ? " + demo catalog (6 products)" : "";
	console.info(`Wrote DashCommerce collection + taxonomies${suffix} to ${target}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

/**
 * Guard for code shared with core. Walks the import graph starting at
 * src/plugin.ts and fails when any module reached from it (including the
 * core modules re-exported by src/shared.ts) has a runtime import of a
 * package. Type-only imports are erased at build time and are allowed.
 * The single allowed runtime package import is `emdash/plugin`, whose
 * `pluginRoute`/`pluginResponse` helpers are tiny and get inlined.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../src/plugin.ts");
const ALLOWED_RUNTIME_PACKAGES = new Set(["emdash/plugin"]);

const IMPORT_RE = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;

function resolveLocal(from: string, spec: string): string {
	const base = resolve(dirname(from), spec);
	for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
		if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
	}
	throw new Error(`Cannot resolve ${spec} from ${from}`);
}

function isTypeOnly(typeKeyword: string | undefined, clause: string): boolean {
	if (typeKeyword) return true;
	const m = clause.match(/^\{([\s\S]*)\}$/);
	if (!m?.[1]) return false;
	return m[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.every((s) => s.startsWith("type "));
}

function walk(): { files: string[]; violations: string[] } {
	const seen = new Set<string>();
	const violations: string[] = [];
	const queue = [ROOT];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(IMPORT_RE)) {
			const [, , typeKw, clause = "", spec = ""] = m;
			const typeOnly = isTypeOnly(typeKw, clause.trim());
			if (spec.startsWith(".")) {
				if (!typeOnly) queue.push(resolveLocal(file, spec));
				continue;
			}
			if (!typeOnly && !ALLOWED_RUNTIME_PACKAGES.has(spec)) {
				violations.push(`${file}: runtime import of "${spec}"`);
			}
		}
	}
	return { files: [...seen], violations };
}

describe("sandbox import graph", () => {
	test("only type imports of packages, plus emdash/plugin helpers", () => {
		const { files, violations } = walk();
		expect(violations).toEqual([]);
		// Sanity check: the walk reached the shared core modules.
		expect(files.some((f) => f.includes("/core/src/money.ts"))).toBe(true);
		expect(files.some((f) => f.includes("/core/src/stripe/webhook-verify.ts"))).toBe(true);
		expect(files.some((f) => f.includes("/core/src/stripe/checkout-sessions.ts"))).toBe(true);
	});
});

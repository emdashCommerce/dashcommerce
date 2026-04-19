import { beforeEach, describe, expect, it } from "bun:test";
import {
	issueRestoreToken,
	verifyRestoreToken,
} from "../src/abandoned-cart/recover";
import {
	issueDownloadToken,
	verifyDownloadToken,
} from "../src/downloads/tokens";

/**
 * Minimal PluginContext stub — only the `kv` surface is exercised by the
 * token helpers. We fake a Map-backed key-value store.
 */
function makeCtxStub() {
	const store = new Map<string, unknown>();
	const kv = {
		async get<T>(key: string): Promise<T | null> {
			return (store.get(key) as T | undefined) ?? null;
		},
		async set(key: string, value: unknown) {
			store.set(key, value);
		},
		async delete(key: string) {
			return store.delete(key);
		},
		async list(prefix = "") {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, value]) => ({ key, value }));
		},
	};
	return { kv, store } as const;
}

describe("download tokens", () => {
	it("round-trips a well-formed token", async () => {
		const { kv } = makeCtxStub();
		const ctx = { kv } as unknown as import("emdash").PluginContext;
		const token = await issueDownloadToken(ctx, {
			grantId: "g-123",
			fileIndex: 0,
		});
		const verified = await verifyDownloadToken(ctx, token);
		expect(verified.ok).toBe(true);
		expect(verified.grantId).toBe("g-123");
		expect(verified.fileIndex).toBe(0);
	});

	it("rejects a malformed token", async () => {
		const { kv } = makeCtxStub();
		const ctx = { kv } as unknown as import("emdash").PluginContext;
		await issueDownloadToken(ctx, { grantId: "g-1", fileIndex: 0 }); // seed secret
		const verified = await verifyDownloadToken(ctx, "not.a.token");
		expect(verified.ok).toBe(false);
	});

	it("rejects a tampered signature", async () => {
		const { kv } = makeCtxStub();
		const ctx = { kv } as unknown as import("emdash").PluginContext;
		const token = await issueDownloadToken(ctx, {
			grantId: "g-1",
			fileIndex: 0,
			ttlMs: 60_000,
		});
		const parts = token.split(".");
		const tampered = parts.slice(0, 3).concat(["0".repeat(64)]).join(".");
		const verified = await verifyDownloadToken(ctx, tampered);
		expect(verified.ok).toBe(false);
		expect(verified.reason).toContain("signature");
	});

	it("rejects an expired token", async () => {
		const { kv } = makeCtxStub();
		const ctx = { kv } as unknown as import("emdash").PluginContext;
		const token = await issueDownloadToken(ctx, {
			grantId: "g-1",
			fileIndex: 0,
			ttlMs: -1, // already expired
		});
		const verified = await verifyDownloadToken(ctx, token);
		expect(verified.ok).toBe(false);
		expect(verified.reason).toBe("expired");
	});
});

describe("cart restore tokens", () => {
	let ctx: import("emdash").PluginContext;
	beforeEach(() => {
		const { kv } = makeCtxStub();
		ctx = { kv } as unknown as import("emdash").PluginContext;
	});

	it("round-trips a restore token", async () => {
		const token = await issueRestoreToken(ctx, "sid-123");
		const verified = await verifyRestoreToken(ctx, token);
		expect(verified.ok).toBe(true);
		expect(verified.sessionId).toBe("sid-123");
	});

	it("rejects a token signed with a different secret", async () => {
		// Issue with one ctx (one secret)
		const tokenA = await issueRestoreToken(ctx, "sid-1");
		// Swap the secret
		await ctx.kv.set("state:cartRestoreSigningSecret", "00".repeat(32));
		const verified = await verifyRestoreToken(ctx, tokenA);
		expect(verified.ok).toBe(false);
	});
});

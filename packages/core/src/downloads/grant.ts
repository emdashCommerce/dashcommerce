/**
 * Grant creation.
 *
 * Called from `orders/create.ts` post-persist for any OrderItem whose
 * product has `isDownloadable: true` + `downloadableFiles`. We create
 * one `DownloadGrant` row per (orderItem × file).
 *
 * Grant uniqueness is enforced by application-level dedup on
 * (orderId, orderItemId, fileIndex) — we check before writing.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import { issueDownloadToken, DEFAULT_MAX_USES } from "./tokens";
import { normalizeProductFields } from "../products/normalize";
import type { DownloadGrant, Order, OrderItem, ProductFields } from "../types";

type GrantsStore = StorageCollection<DownloadGrant>;

function grantsStore(ctx: PluginContext): GrantsStore {
	return (ctx.storage as unknown as { download_grants: GrantsStore }).download_grants;
}

async function readMaxUses(ctx: PluginContext): Promise<number> {
	return (await ctx.kv.get<number>("settings:downloadMaxUses")) ?? DEFAULT_MAX_USES;
}

async function readExpiryDays(ctx: PluginContext): Promise<number> {
	return (await ctx.kv.get<number>("settings:downloadGrantExpiryDays")) ?? 30;
}

async function loadProduct(
	ctx: PluginContext,
	productId: string,
): Promise<ProductFields | null> {
	if (!ctx.content) return null;
	const record = await ctx.content.get("products", productId);
	return record
		? normalizeProductFields(record.data as Record<string, unknown>)
		: null;
}

export interface IssuedGrant {
	grant: DownloadGrant;
	token: string;
	url: string; // absolute, using ctx.site
}

/**
 * Create download grants for every digital file on every digital item in
 * this order. Returns the issued grants + freshly-signed tokens so the
 * caller can embed them in the receipt email.
 *
 * Idempotent: if grants already exist for (orderId, orderItemId, fileIndex)
 * we skip re-creation and re-issue only the token.
 */
export async function issueGrantsForOrder(
	ctx: PluginContext,
	order: Order,
	items: OrderItem[],
): Promise<IssuedGrant[]> {
	const maxUses = await readMaxUses(ctx);
	const expiryDays = await readExpiryDays(ctx);
	const expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString();

	const results: IssuedGrant[] = [];
	for (const item of items) {
		if (!item.isDigital) continue;
		const product = await loadProduct(ctx, item.productId);
		if (!product?.isDownloadable) continue;
		const files = product.downloadableFiles ?? [];
		for (let idx = 0; idx < files.length; idx += 1) {
			const file = files[idx];
			if (!file) continue;
			const existing = await findGrantForFile(ctx, order.id, item.id, idx);
			const grant: DownloadGrant = existing ?? {
				id: randomId(),
				orderId: order.id,
				orderItemId: item.id,
				productId: item.productId,
				customerEmail: order.customerEmail,
				fileIndex: idx,
				fileName: file.name,
				...(file.mediaId ? { mediaId: file.mediaId } : {}),
				...(file.url ? { externalUrl: file.url } : {}),
				maxUses,
				usesCount: 0,
				expiresAt,
				createdAt: new Date().toISOString(),
			};
			if (!existing) await grantsStore(ctx).put(grant.id, grant);
			const token = await issueDownloadToken(ctx, {
				grantId: grant.id,
				fileIndex: idx,
			});
			const url = ctx.url(
				`/_emdash/api/plugins/${ctx.plugin.id}/downloads/serve?token=${encodeURIComponent(token)}`,
			);
			results.push({ grant, token, url });
		}
	}
	return results;
}

export async function findGrantForFile(
	ctx: PluginContext,
	orderId: string,
	orderItemId: string,
	fileIndex: number,
): Promise<DownloadGrant | null> {
	// `orderId` is indexed; filter the rest in memory (fileIndex is not
	// indexed per phase 5 storage-collections.ts to keep indexes flat).
	const res = await grantsStore(ctx).query({ where: { orderId }, limit: 100 });
	for (const row of res.items) {
		const g = row.data as DownloadGrant;
		if (g.orderItemId === orderItemId && g.fileIndex === fileIndex) {
			return { ...g, id: row.id };
		}
	}
	return null;
}

export async function getGrant(
	ctx: PluginContext,
	grantId: string,
): Promise<DownloadGrant | null> {
	const raw = await grantsStore(ctx).get(grantId);
	if (!raw) return null;
	return { ...(raw as DownloadGrant), id: grantId };
}

export async function listGrantsForOrder(
	ctx: PluginContext,
	orderId: string,
): Promise<DownloadGrant[]> {
	const res = await grantsStore(ctx).query({ where: { orderId }, limit: 200 });
	return res.items.map((r) => ({ ...(r.data as DownloadGrant), id: r.id }));
}

/**
 * Atomic-ish uses increment. There's no true compare-and-swap in the
 * storage API; we read, validate, then write. Races here just mean a
 * generous customer gets one extra download — acceptable.
 */
export async function consumeGrantUse(
	ctx: PluginContext,
	grantId: string,
): Promise<{ ok: true; grant: DownloadGrant } | { ok: false; reason: string }> {
	const grant = await getGrant(ctx, grantId);
	if (!grant) return { ok: false, reason: "grant not found" };
	if (Date.parse(grant.expiresAt) < Date.now()) return { ok: false, reason: "grant expired" };
	if (grant.usesCount >= grant.maxUses) return { ok: false, reason: "grant exhausted" };
	const updated: DownloadGrant = { ...grant, usesCount: grant.usesCount + 1 };
	await grantsStore(ctx).put(grant.id, updated);
	return { ok: true, grant: updated };
}

/**
 * Serve a download via signed token → 302 redirect.
 *
 * We don't proxy file bytes. Two delivery strategies:
 *
 *   - `grant.mediaId` present → fetch a signed URL from `ctx.media` when
 *     available; otherwise fall back to `ctx.media.get(id).url` (best
 *     effort — the emdash media API shape varies).
 *   - `grant.externalUrl` present → 302 to it.
 *
 * Use-count is incremented *before* the redirect is written so a client
 * cancelling the response mid-flight still counts against their quota.
 */

import type { MediaAccess, PluginContext } from "emdash";
import type { DownloadGrant } from "../types";
import { consumeGrantUse } from "./grant";
import { verifyDownloadToken } from "./tokens";

export interface ServeResult {
	response: Response;
	grantId?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function resolveMediaUrl(
	ctx: PluginContext,
	mediaId: string,
): Promise<string | null> {
	const media = ctx.media as MediaAccess | undefined;
	if (!media) return null;
	try {
		const item = await media.get(mediaId);
		return item?.url ?? null;
	} catch (err) {
		ctx.log.warn("Failed to resolve media URL", {
			mediaId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

export async function serveDownload(
	ctx: PluginContext,
	token: string,
): Promise<ServeResult> {
	const verified = await verifyDownloadToken(ctx, token);
	if (!verified.ok || !verified.grantId) {
		return {
			response: jsonResponse({ error: `Invalid token: ${verified.reason}` }, 401),
		};
	}
	const consume = await consumeGrantUse(ctx, verified.grantId);
	if (!consume.ok) {
		return {
			response: jsonResponse({ error: consume.reason }, 410),
			grantId: verified.grantId,
		};
	}
	const grant: DownloadGrant = consume.grant;
	if (verified.fileIndex !== grant.fileIndex) {
		return {
			response: jsonResponse({ error: "fileIndex mismatch" }, 400),
			grantId: verified.grantId,
		};
	}

	let target: string | null = null;
	if (grant.mediaId) target = await resolveMediaUrl(ctx, grant.mediaId);
	if (!target && grant.externalUrl) target = grant.externalUrl;
	if (!target) {
		return {
			response: jsonResponse({ error: "Download target unavailable" }, 404),
			grantId: verified.grantId,
		};
	}

	return {
		response: new Response(null, {
			status: 302,
			headers: {
				Location: target,
				"Cache-Control": "no-store, private",
			},
		}),
		grantId: verified.grantId,
	};
}

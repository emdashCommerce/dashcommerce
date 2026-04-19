/**
 * Public download route.
 *
 *   GET /downloads/serve?token=…
 *
 * Verifies the HMAC-signed token, increments the grant's `usesCount`, and
 * 302-redirects to either the emdash media URL or the external file URL.
 * No auth beyond the token — customers share URLs via email.
 *
 * NOTE: Emdash's plugin route registry does exact-string matching, so the
 * token is passed as a query parameter rather than a path segment. A legacy
 * path fallback (`/downloads/<token>`) is preserved so stale email links
 * from older releases still resolve.
 */

import type { PluginContext, RouteContext } from "emdash";
import { serveDownload } from "../downloads/serve";

function parseToken(req: Request): string | null {
	const url = new URL(req.url);
	const q = url.searchParams.get("token");
	if (q && q.length > 0) return q;
	const parts = url.pathname.split("/").filter(Boolean);
	const idx = parts.lastIndexOf("downloads");
	if (idx === -1) return null;
	const seg = parts[idx + 1];
	if (seg === "serve") return null;
	return seg ?? null;
}

export const downloadsRoutes = {
	"downloads/serve": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext): Promise<Response> => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const token = parseToken(routeCtx.request);
			if (!token) {
				return new Response(JSON.stringify({ error: "Missing token" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			const { response, grantId } = await serveDownload(ctx, token);
			if (grantId && response.status >= 300 && response.status < 400) {
				ctx.log.info("Download served", { grantId });
			}
			return response;
		},
	},
};

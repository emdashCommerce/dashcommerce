/**
 * CSV export of orders.
 *
 * Private plugin routes need the `X-EmDash-Request` header, which a plain
 * download link cannot send. So the Orders page mints a one-time export
 * token (32 random bytes, kept in KV as its SHA-256 for 5 minutes) and
 * links to the public `orders/export` raw route with it. The route
 * consumes the token and streams the CSV with a download filename.
 *
 * One export reads at most 800 orders (8 pages of 100), newest first, so
 * the download stays within the 10-subrequest sandbox budget (budget.ts).
 * The response sets `X-DashCommerce-Truncated: true` when there were more.
 */

import type { PluginContext } from "emdash/plugin";
import { metered } from "./budget";
import { mintToken, sha256Hex } from "./cart";
import { type LiteOrder, ordersStore } from "./orders";
import { minorUnitsFactor, type Money, type OrderStatus } from "./shared";
import { asObject, asString } from "./validate";

export const EXPORT_TTL_MS = 5 * 60 * 1000;
const PAGE = 100;
// kv read + kv delete + 8 pages = 10 bridge calls, the sandbox budget.
const MAX_PAGES = 8;

interface ExportGrant {
	status: OrderStatus | null;
	expiresAt: string;
}

const exportKey = (hash: string) => `export:${hash}`;

/** Create a one-time download URL for the CSV. */
export async function createExportUrl(
	ctx: PluginContext,
	status: OrderStatus | null,
	now = Date.now(),
): Promise<string> {
	const token = mintToken();
	const grant: ExportGrant = { status, expiresAt: new Date(now + EXPORT_TTL_MS).toISOString() };
	await ctx.kv.set(exportKey(await sha256Hex(token)), grant);
	const base = ctx.site.url.replace(/\/+$/, "");
	return `${base}/_emdash/api/plugins/${ctx.plugin.id}/orders/export?token=${token}`;
}

export interface RawResult {
	status: number;
	headers: Record<string, string>;
	body: string;
}

export async function handleExport(
	rawCtx: PluginContext,
	input: unknown,
	now = Date.now(),
): Promise<RawResult> {
	const ctx = metered(rawCtx);
	const token = asString(asObject(input).token, 64);
	const denied: RawResult = {
		status: 403,
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		body: "This export link is invalid or has expired. Export again from the Orders page.",
	};
	if (!token) return denied;
	const key = exportKey(await sha256Hex(token));
	const grant = await ctx.kv.get<ExportGrant>(key);
	if (!grant) return denied;
	await ctx.kv.delete(key);
	if (Date.parse(grant.expiresAt) <= now) return denied;

	const store = ordersStore(ctx);
	const rows: Array<{ id: string; data: LiteOrder }> = [];
	let cursor: string | undefined;
	let truncated = false;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const res = await store.query({
			...(grant.status ? { where: { status: grant.status } } : {}),
			orderBy: { createdAt: "desc" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		rows.push(...res.items);
		if (!res.hasMore || !res.cursor) break;
		cursor = res.cursor;
		if (page === MAX_PAGES - 1) truncated = true;
	}
	const date = new Date(now).toISOString().slice(0, 10);
	return {
		status: 200,
		headers: {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": `attachment; filename="dashcommerce-orders-${date}.csv"`,
			"cache-control": "no-store",
			...(truncated ? { "x-dashcommerce-truncated": "true" } : {}),
		},
		body: ordersCsv(rows),
	};
}

export const CSV_COLUMNS = [
	"order_number",
	"order_id",
	"created_at",
	"paid_at",
	"status",
	"payment_status",
	"currency",
	"subtotal",
	"shipping",
	"tax",
	"total",
	"refunded",
	"customer_email",
	"items",
	"ship_name",
	"ship_line1",
	"ship_line2",
	"ship_city",
	"ship_state",
	"ship_postal_code",
	"ship_country",
	"stripe_payment_intent",
] as const;

export function ordersCsv(rows: Array<{ id: string; data: LiteOrder }>): string {
	const lines = [CSV_COLUMNS.join(",")];
	for (const { id, data: o } of rows) {
		const a = o.shippingAddress ?? {};
		const amount = (m: Money | undefined) => decimal(m?.amount ?? 0, o.currency);
		const cells = [
			o.orderNumber,
			id,
			o.createdAt,
			o.paidAt ?? "",
			o.status,
			o.paymentStatus,
			o.currency,
			amount(o.subtotal),
			amount(o.shippingTotal),
			amount(o.taxTotal),
			amount(o.total),
			decimal(o.refundedAmount ?? 0, o.currency),
			o.customerEmail ?? "",
			o.items.map((i) => `${i.quantity} x ${i.title}`).join("; "),
			a.name ?? "",
			a.line1 ?? "",
			a.line2 ?? "",
			a.city ?? "",
			a.state ?? "",
			a.postalCode ?? "",
			a.country ?? "",
			o.stripePaymentIntentId ?? "",
		];
		lines.push(cells.map(csvCell).join(","));
	}
	return `${lines.join("\r\n")}\r\n`;
}

/** Minor units to a plain decimal string ("12.50"), no currency symbol. */
function decimal(minor: number, currency: string): string {
	const factor = minorUnitsFactor(currency);
	const digits = Math.round(Math.log10(factor));
	return (minor / factor).toFixed(digits);
}

/**
 * Quote a CSV cell. Cells that a spreadsheet would read as a formula get a
 * leading apostrophe, so shopper-entered text cannot run as a formula.
 */
export function csvCell(value: string): string {
	let v = value;
	if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
	return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

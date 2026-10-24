/**
 * Block Kit admin: Orders, Stock and Settings pages, plus the Recent orders
 * dashboard widget.
 *
 * EmDash posts `page_load`, `block_action` and `form_submit` interactions
 * to the private `admin` route and renders the blocks we return. No
 * browser code ships with the plugin.
 */

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks/server";
import type { PluginContext } from "emdash/plugin";
import { createExportUrl } from "./export";
import { applyStatus, type LiteOrder, ordersStore, updateOrder } from "./orders";
import { PRODUCTS_COLLECTION } from "./products";
import {
	formatAmount,
	isStripeSecretKey,
	isStripeWebhookSecret,
	isValidReturnUrl,
	loadConfig,
	normalizeCurrency,
	parseAmount,
	parseCountries,
	parsePercent,
} from "./settings";
import { format, type Money, normalizeProductFields, type OrderStatus } from "./shared";
import { restoreStock, setOnHand, stockStore, syncFromProducts } from "./stock";
import { asInt, asObject, asString } from "./validate";
import { HANDLED_EVENTS } from "./webhook";

const PAGE_SIZE = 25;
const ADMIN_STATUSES: OrderStatus[] = ["processing", "on-hold", "completed", "cancelled"];
const ALL_STATUSES: OrderStatus[] = [
	"pending",
	"processing",
	"on-hold",
	"completed",
	"cancelled",
	"refunded",
	"partially-refunded",
	"failed",
];
export const RECENT_ORDERS_WIDGET = "recent-orders";
const MAX_STOCK = 1_000_000;

export async function handleAdmin(ctx: PluginContext, input: unknown): Promise<BlockResponse> {
	const interaction = asObject(input);
	const type = interaction.type;

	if (type === "page_load") {
		const page = asString(interaction.page) ?? "/orders";
		if (page === "/settings") return renderSettings(ctx);
		if (page === "/stock") return renderStock(ctx);
		if (page === `widget:${RECENT_ORDERS_WIDGET}`) return renderRecentOrdersWidget(ctx);
		return renderOrders(ctx);
	}

	if (type === "block_action") {
		const actionId = asString(interaction.action_id) ?? "";
		const value = interaction.value;
		const str = typeof value === "string" ? value : undefined;
		if (actionId === "view_order" && str) return renderOrder(ctx, str);
		if (actionId === "orders_page" || actionId.startsWith("orders_page:")) {
			const status = parseStatus(actionId.slice("orders_page:".length));
			return renderOrders(ctx, { status, cursor: str });
		}
		if (actionId === "filter_status") return renderOrders(ctx, { status: parseStatus(value) });
		if (actionId === "export_csv") {
			const status = parseStatus(value);
			return renderOrders(ctx, { status, exportUrl: await createExportUrl(ctx, status) });
		}
		if (actionId === "back_to_orders") return renderOrders(ctx);
		if (actionId === "set_status" && str) return setStatus(ctx, str);
		if (actionId === "stock_page") return renderStock(ctx, { cursor: str });
		if (actionId === "adjust_stock" && str) return renderStock(ctx, { adjust: str });
		if (actionId === "sync_stock") return syncStock(ctx);
		if (actionId === "clear_secret_key" || actionId === "clear_webhook_secret") {
			const key = actionId === "clear_secret_key" ? "stripeSecretKey" : "stripeWebhookSecret";
			await ctx.settings.delete(key);
			return {
				...(await renderSettings(ctx)),
				toast: { message: "Secret removed", type: "success" },
			};
		}
		return renderOrders(ctx);
	}

	if (type === "form_submit") {
		const values = asObject(interaction.values);
		if (interaction.action_id === "save_settings") return saveSettings(ctx, values);
		if (interaction.action_id === "search_orders") {
			return renderOrders(ctx, { search: asString(values.q, 254) });
		}
		if (interaction.action_id === "save_stock") {
			return saveStock(ctx, asString(interaction.block_id, 200) ?? "", values);
		}
	}

	return { blocks: [] };
}

function money(m: Money | undefined, currency = "USD"): string {
	return format(m ?? { currency, amount: 0 });
}

function parseStatus(value: unknown): OrderStatus | null {
	return typeof value === "string" && (ALL_STATUSES as string[]).includes(value)
		? (value as OrderStatus)
		: null;
}

// ── Orders ──────────────────────────────────────────────────────────────

/**
 * Exact-match search on an indexed field: order number (DCL-...),
 * customer email, Stripe PaymentIntent (pi_...) or Checkout Session (cs_...).
 */
export function searchWhere(q: string): Record<string, string> | null {
	const s = q.trim();
	if (/^DCL-[A-Z0-9-]+$/i.test(s)) return { orderNumber: s.toUpperCase() };
	if (/^[^\s@]+@[^\s@]+$/.test(s)) return { customerEmail: s.toLowerCase() };
	if (/^pi_[A-Za-z0-9]+$/.test(s)) return { stripePaymentIntentId: s };
	if (/^cs_[A-Za-z0-9_]+$/.test(s)) return { stripeSessionId: s };
	return null;
}

function orderRows(items: Array<{ id: string; data: LiteOrder }>) {
	return items.map(({ id, data }) => ({
		number: data.orderNumber,
		created: data.createdAt,
		status: data.status,
		payment: data.paymentStatus,
		total: money(data.total),
		email: data.customerEmail ?? "",
		action: { type: "button", action_id: "view_order", label: "View", value: id },
	}));
}

const ORDER_COLUMNS = [
	{ key: "number", label: "Order", format: "code" as const },
	{ key: "created", label: "Created", format: "relative_time" as const },
	{ key: "status", label: "Status", format: "badge" as const },
	{ key: "payment", label: "Payment", format: "badge" as const },
	{ key: "total", label: "Total" },
	{ key: "email", label: "Customer" },
	{ key: "action", label: "", format: "element" as const },
];

export async function renderOrders(
	ctx: PluginContext,
	opts: {
		status?: OrderStatus | null;
		cursor?: string | undefined;
		search?: string | undefined;
		exportUrl?: string;
	} = {},
): Promise<BlockResponse> {
	const store = ordersStore(ctx);
	const status = opts.status ?? null;
	const searchFilter = opts.search ? searchWhere(opts.search) : null;
	const where = searchFilter ?? (status ? { status } : undefined);
	const [page, paidCount, pendingCount, refundedCount] = await Promise.all([
		opts.search && !searchFilter
			? Promise.resolve({ items: [], hasMore: false, cursor: undefined })
			: store.query({
					...(where ? { where } : {}),
					orderBy: { createdAt: "desc" },
					limit: PAGE_SIZE,
					...(opts.cursor ? { cursor: opts.cursor } : {}),
				}),
		store.count({ paymentStatus: "paid" }),
		store.count({ status: "pending" }),
		store.count({ paymentStatus: "refunded" }),
	]);

	const blocks: Block[] = [
		{ type: "header", text: "Orders" },
		{
			type: "stats",
			items: [
				{ label: "Paid orders", value: paidCount },
				{ label: "Awaiting payment", value: pendingCount },
				{ label: "Refunded", value: refundedCount },
			],
		},
		{
			type: "actions",
			elements: [
				{
					type: "menu",
					action_id: "filter_status",
					label: status ? `Status: ${status}` : "Status: all",
					items: [
						{ label: "All statuses", value: "all" },
						...ALL_STATUSES.map((s) => ({ label: s, value: s })),
					],
				},
				{
					type: "button",
					action_id: "export_csv",
					label: status ? `Export ${status} orders (CSV)` : "Export orders (CSV)",
					style: "secondary",
					value: status ?? "all",
				},
			],
		},
		{
			type: "form",
			block_id: "order_search",
			fields: [
				{
					type: "text_input",
					action_id: "q",
					label: "Find an order by number, customer email, or Stripe pi_/cs_ id",
					...(opts.search ? { initial_value: opts.search } : {}),
				},
			],
			submit: { label: "Search", action_id: "search_orders" },
		},
	];
	if (opts.exportUrl) {
		blocks.push({
			type: "section",
			text: "Your export is ready. The link works once, for 5 minutes.",
			accessory: {
				type: "link",
				label: "Download CSV",
				target: { kind: "external", url: opts.exportUrl },
				appearance: "primary",
			},
		});
	}
	if (opts.search) {
		blocks.push(
			searchFilter
				? { type: "context", text: `Results for "${opts.search}"` }
				: {
						type: "banner",
						variant: "alert",
						title: "Search needs an exact value",
						description:
							"Enter a full order number (DCL-...), a customer email, or a Stripe id (pi_... or cs_...).",
					},
			{
				type: "actions",
				elements: [{ type: "button", action_id: "back_to_orders", label: "Clear search" }],
			},
		);
	}
	blocks.push({
		type: "table",
		page_action_id: status && !opts.search ? `orders_page:${status}` : "orders_page",
		empty_text: opts.search ? "No matching orders" : "No orders yet",
		columns: ORDER_COLUMNS,
		rows: orderRows(page.items),
		...(page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
	});
	return { blocks };
}

export async function renderOrder(ctx: PluginContext, id: string): Promise<BlockResponse> {
	const order = await ordersStore(ctx).get(id);
	if (!order) {
		return {
			blocks: [{ type: "banner", title: "Order not found", variant: "error" }, backButton()],
		};
	}
	return { blocks: orderBlocks(id, order) };
}

function stripePaymentUrl(o: LiteOrder): string | null {
	if (!o.stripePaymentIntentId) return null;
	const mode = o.livemode === false ? "test/" : "";
	return `https://dashboard.stripe.com/${mode}payments/${encodeURIComponent(o.stripePaymentIntentId)}`;
}

function orderBlocks(id: string, o: LiteOrder): Block[] {
	const c = o.currency;
	const fields = [
		{ label: "Status", value: o.status },
		{ label: "Payment", value: o.paymentStatus },
		{ label: "Subtotal", value: money(o.subtotal, c) },
		{ label: "Shipping", value: money(o.shippingTotal, c) },
		{
			label: "Tax",
			value:
				o.automaticTax && o.paymentStatus === "pending"
					? "Added by Stripe Tax at checkout"
					: money(o.taxTotal, c),
		},
		{ label: "Total", value: money(o.total, c) },
		{
			label: "Refunded",
			value: o.refundedAmount ? money({ currency: c, amount: o.refundedAmount }) : "None",
		},
		{ label: "Customer", value: o.customerEmail ?? "Not provided" },
		{ label: "Created", value: o.createdAt },
		{ label: "Paid", value: o.paidAt ?? "Not paid" },
		{ label: "Stripe session", value: o.stripeSessionId ?? "None" },
		{ label: "Payment intent", value: o.stripePaymentIntentId ?? "None" },
	];
	if (o.stock) {
		fields.push({
			label: "Stock",
			value: o.stock === "deducted" ? "Taken from stock" : "Returned to stock",
		});
	}
	if (o.shippingAddress) {
		const a = o.shippingAddress;
		fields.push({
			label: "Ship to",
			value: [a.name, a.line1, a.line2, a.city, a.state, a.postalCode, a.country]
				.filter(Boolean)
				.join(", "),
		});
	}
	const blocks: Block[] = [{ type: "header", text: `Order ${o.orderNumber}` }];
	if (o.amountMismatch) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Amount mismatch",
			description: `Stripe charged ${o.amountMismatch.received.amount} ${o.amountMismatch.received.currency}; the order expected ${money(o.amountMismatch.expected)}. Check the payment in Stripe before fulfilling.`,
		});
	}
	if (o.awaitingAsyncPayment && o.paymentStatus === "pending" && o.status === "on-hold") {
		blocks.push({
			type: "banner",
			title: "Waiting for payment",
			description:
				"The shopper paid with a delayed method such as a bank debit. Stripe confirms or fails the payment within a few days; do not fulfil until then.",
		});
	}
	if (o.stockShortfall?.length) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Not enough stock",
			description: `This order was paid for more than the stock on hand: ${o.stockShortfall
				.map((s) => `${s.title} (${s.short} short)`)
				.join(", ")}. Restock, or refund the order in Stripe.`,
		});
	}
	if (o.paymentStatus === "refunded" || o.paymentStatus === "partially-refunded") {
		blocks.push({
			type: "banner",
			title: o.paymentStatus === "refunded" ? "Refunded in full" : "Partly refunded",
			description: `${money({ currency: c, amount: o.refundedAmount ?? 0 })} refunded${o.refundedAt ? ` (last refund ${o.refundedAt})` : ""}.`,
		});
	}
	blocks.push(
		{ type: "fields", fields },
		{
			type: "table",
			page_action_id: "order_items_page",
			columns: [
				{ key: "title", label: "Product" },
				{ key: "quantity", label: "Qty", format: "number" },
				{ key: "unit", label: "Unit price" },
				{ key: "line", label: "Line total" },
			],
			rows: o.items.map((i) => ({
				title: i.title,
				quantity: i.quantity,
				unit: money(i.unitPrice),
				line: money(i.lineTotal),
			})),
		},
	);
	const transitions = ADMIN_STATUSES.filter((s) => applyStatus(o, s) !== null);
	const stripeUrl = stripePaymentUrl(o);
	blocks.push({
		type: "actions",
		elements: [
			...transitions.map((s) => ({
				type: "button" as const,
				action_id: "set_status",
				label: `Mark ${s}`,
				value: `${id}:${s}`,
				...(s === "cancelled"
					? {
							style: "danger" as const,
							confirm: {
								title: "Cancel this order?",
								text: "This does not refund the payment. Refund it in Stripe first if needed. Stock taken by this order goes back.",
								confirm: "Cancel order",
								deny: "Keep",
								style: "danger" as const,
							},
						}
					: {}),
			})),
			...(stripeUrl
				? [
						{
							type: "link" as const,
							label: "Open in Stripe (refunds)",
							target: { kind: "external" as const, url: stripeUrl },
						},
					]
				: []),
			{ type: "button", action_id: "back_to_orders", label: "Back to orders", style: "secondary" },
		],
	});
	return blocks;
}

function backButton(): Block {
	return {
		type: "actions",
		elements: [{ type: "button", action_id: "back_to_orders", label: "Back to orders" }],
	};
}

async function setStatus(ctx: PluginContext, value: string): Promise<BlockResponse> {
	const sep = value.lastIndexOf(":");
	const id = value.slice(0, sep);
	const to = value.slice(sep + 1) as OrderStatus;
	if (sep <= 0 || !ADMIN_STATUSES.includes(to)) {
		return { blocks: [], toast: { message: "Unknown action", type: "error" } };
	}
	const { order, written } = await updateOrder(ordersStore(ctx), id, (o) => applyStatus(o, to));
	if (!order) return renderOrder(ctx, id);
	// Idempotent per line (stock_moves), so a repeated click also finishes
	// a restore that failed part-way.
	if (order.stock === "restored" && order.status === "cancelled") {
		await restoreStock(ctx, id, order.items, "cancel");
	}
	return {
		blocks: orderBlocks(id, order),
		toast: written
			? { message: `Order marked ${to}`, type: "success" }
			: { message: `Cannot move a ${order.status} order to ${to}`, type: "error" },
	};
}

// ── Dashboard widget ────────────────────────────────────────────────────

export async function renderRecentOrdersWidget(ctx: PluginContext): Promise<BlockResponse> {
	const store = ordersStore(ctx);
	const [recent, pendingCount] = await Promise.all([
		store.query({ orderBy: { createdAt: "desc" }, limit: 5 }),
		store.count({ status: "pending" }),
	]);
	return {
		blocks: [
			{
				type: "table",
				page_action_id: "widget_orders_page",
				empty_text: "No orders yet",
				columns: [
					{ key: "number", label: "Order", format: "code" },
					{ key: "created", label: "Created", format: "relative_time" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "total", label: "Total" },
				],
				rows: recent.items.map(({ data }) => ({
					number: data.orderNumber,
					created: data.createdAt,
					status: data.status,
					total: money(data.total),
				})),
			},
			{
				type: "context",
				text: `${pendingCount} awaiting payment`,
			},
			{
				type: "actions",
				elements: [
					{ type: "link", label: "All orders", target: { kind: "plugin-page", path: "/orders" } },
				],
			},
		],
	};
}

// ── Stock ───────────────────────────────────────────────────────────────

export async function renderStock(
	ctx: PluginContext,
	opts: { cursor?: string | undefined; adjust?: string } = {},
): Promise<BlockResponse> {
	const store = stockStore(ctx);
	const [page, editing] = await Promise.all([
		store.query({
			orderBy: { title: "asc" },
			limit: PAGE_SIZE,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
		opts.adjust ? store.get(opts.adjust) : Promise.resolve(null),
	]);
	const blocks: Block[] = [
		{ type: "header", text: "Stock" },
		{
			type: "section",
			text: "DashCommerce keeps its own stock count for products with stock management on. A sale takes stock when Stripe confirms payment; a full refund or a cancelled paid order puts it back. Changing stock_quantity on a product replaces the count here at the next sale or sync.",
		},
	];
	if (editing && opts.adjust) {
		blocks.push(
			{
				type: "form",
				block_id: `stock-adjust:${opts.adjust}`,
				fields: [
					{
						type: "number_input",
						action_id: "onHand",
						label: `On hand: ${editing.title}`,
						initial_value: editing.onHand,
						min: 0,
						max: MAX_STOCK,
					},
				],
				submit: { label: "Save stock", action_id: "save_stock" },
			},
			{
				type: "actions",
				elements: [{ type: "button", action_id: "stock_page", label: "Cancel" }],
			},
		);
	}
	blocks.push(
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "sync_stock",
					label: "Add tracked products",
					style: "secondary",
				},
			],
		},
		{
			type: "table",
			page_action_id: "stock_page",
			empty_text:
				"No stock rows yet. Rows are added at the first sale of a tracked product, or with Add tracked products.",
			columns: [
				{ key: "title", label: "Product" },
				{ key: "onHand", label: "On hand", format: "number" },
				{ key: "baseline", label: "Product stock_quantity at last sync", format: "number" },
				{ key: "updated", label: "Updated", format: "relative_time" },
				{ key: "action", label: "", format: "element" },
			],
			rows: page.items.map(({ id, data }) => ({
				title: data.title,
				onHand: data.onHand,
				baseline: data.baseline,
				updated: data.updatedAt,
				action: { type: "button", action_id: "adjust_stock", label: "Adjust", value: id },
			})),
			...(page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
		},
	);
	return { blocks };
}

async function saveStock(
	ctx: PluginContext,
	blockId: string,
	values: Record<string, unknown>,
): Promise<BlockResponse> {
	const productId = blockId.startsWith("stock-adjust:") ? blockId.slice(13) : "";
	const onHand = asInt(values.onHand, 0, MAX_STOCK);
	if (!productId || onHand === undefined) {
		return {
			...(await renderStock(ctx, productId ? { adjust: productId } : {})),
			toast: { message: `Enter a whole number from 0 to ${MAX_STOCK}`, type: "error" },
		};
	}
	const row = await setOnHand(ctx, productId, onHand);
	return {
		...(await renderStock(ctx)),
		toast: row
			? { message: `${row.title}: ${row.onHand} on hand`, type: "success" }
			: { message: "No stock row for that product", type: "error" },
	};
}

async function syncStock(ctx: PluginContext): Promise<BlockResponse> {
	if (!ctx.content) {
		return { ...(await renderStock(ctx)), toast: { message: "No content access", type: "error" } };
	}
	const list = await ctx.content.list(PRODUCTS_COLLECTION, {
		limit: 100,
		where: { status: "published" },
	});
	const products = list.items.map((item) => ({
		id: item.id,
		fields: normalizeProductFields(item.data),
	}));
	const { created, reset } = await syncFromProducts(ctx, products);
	return {
		...(await renderStock(ctx)),
		toast: {
			message:
				created || reset
					? `Added ${created}, reset ${reset} from product stock_quantity`
					: "Stock is up to date",
			type: "success",
		},
	};
}

// ── Settings ────────────────────────────────────────────────────────────

export async function renderSettings(ctx: PluginContext): Promise<BlockResponse> {
	const config = await loadConfig(ctx);
	const sk = config.stripeSecretKey;
	const wh = config.stripeWebhookSecret;
	const webhookUrl = `${ctx.site.url.replace(/\/+$/, "")}/_emdash/api/plugins/${ctx.plugin.id}/stripe/webhook`;
	const ready = Boolean(sk && wh);
	const fields: FormField[] = [
		{
			type: "secret_input",
			action_id: "stripeSecretKey",
			label: "Stripe secret key (sk_... or restricted rk_...)",
			has_value: Boolean(sk),
		},
		{
			type: "secret_input",
			action_id: "stripeWebhookSecret",
			label: "Stripe webhook signing secret (whsec_...)",
			has_value: Boolean(wh),
		},
		{
			type: "text_input",
			action_id: "currency",
			label: "Store currency (ISO 4217, for example USD)",
			initial_value: config.currency,
		},
		{
			type: "text_input",
			action_id: "successUrl",
			label: "Success URL ({ORDER_ID} and {ORDER_KEY} are replaced)",
			initial_value: config.successUrl,
		},
		{
			type: "text_input",
			action_id: "cancelUrl",
			label: "Cancel URL",
			initial_value: config.cancelUrl,
		},
		{
			type: "text_input",
			action_id: "shippingCountries",
			label:
				"Collect a shipping address for these countries (ISO-2, comma separated; empty = none)",
			initial_value: config.shippingCountries.join(","),
		},
		{
			type: "text_input",
			action_id: "flatShipping",
			label: "Flat shipping per order with a physical item, in the store currency (empty = free)",
			placeholder: "4.99",
			initial_value: formatAmount(config.flatShipping, config.currency),
		},
		{
			type: "toggle",
			action_id: "automaticTax",
			label: "Use Stripe Tax",
			description:
				"Stripe adds tax on the Checkout page. Needs Stripe Tax set up on your Stripe account, including a default tax behavior for shipping.",
			initial_value: config.automaticTax,
		},
		{
			type: "text_input",
			action_id: "flatTaxPercent",
			label: "Flat tax rate on the item subtotal, in percent (empty = none)",
			placeholder: "8.25",
			initial_value: config.flatTaxPercent ? String(config.flatTaxPercent) : "",
			condition: { field: "automaticTax", eq: false },
		},
	];
	const blocks: Block[] = [
		{ type: "header", text: "DashCommerce settings" },
		ready
			? { type: "banner", title: "Stripe is configured" }
			: {
					type: "banner",
					variant: "alert",
					title: "Stripe is not configured",
					description: "Add the secret key and the webhook signing secret to accept payments.",
				},
		{
			type: "section",
			text: `Create a Stripe webhook endpoint for this URL and subscribe it to ${HANDLED_EVENTS.join(", ")}:\n${webhookUrl}`,
		},
		{
			type: "form",
			block_id: "settings",
			fields,
			submit: { label: "Save", action_id: "save_settings" },
		},
		{
			type: "actions",
			elements: [
				clearButton("clear_secret_key", "Remove secret key", Boolean(sk)),
				clearButton("clear_webhook_secret", "Remove webhook secret", Boolean(wh)),
			].filter((b): b is NonNullable<typeof b> => b !== null),
		},
		{
			type: "context",
			text: "Secrets are encrypted by EmDash and never sent back to the browser. A restricted key needs write access to Checkout Sessions only.",
		},
	];
	return { blocks };
}

function clearButton(actionId: string, label: string, show: boolean) {
	if (!show) return null;
	return {
		type: "button" as const,
		action_id: actionId,
		label,
		style: "danger" as const,
		confirm: {
			title: `${label}?`,
			text: "Checkout stops working until a new value is saved.",
			confirm: "Remove",
			deny: "Cancel",
			style: "danger" as const,
		},
	};
}

export async function saveSettings(
	ctx: PluginContext,
	values: Record<string, unknown>,
): Promise<BlockResponse> {
	const errors: string[] = [];
	const writes: Array<[string, unknown]> = [];

	const sk = typeof values.stripeSecretKey === "string" ? values.stripeSecretKey.trim() : "";
	if (sk) {
		if (isStripeSecretKey(sk)) writes.push(["stripeSecretKey", sk]);
		else errors.push("The Stripe secret key must start with sk_ or rk_.");
	}
	const wh =
		typeof values.stripeWebhookSecret === "string" ? values.stripeWebhookSecret.trim() : "";
	if (wh) {
		if (isStripeWebhookSecret(wh)) writes.push(["stripeWebhookSecret", wh]);
		else errors.push("The webhook signing secret must start with whsec_.");
	}
	const currency = normalizeCurrency(values.currency);
	if (currency) writes.push(["currency", currency]);
	else errors.push("Currency must be a three-letter ISO 4217 code.");

	for (const key of ["successUrl", "cancelUrl"] as const) {
		const v = typeof values[key] === "string" ? (values[key] as string).trim() : "";
		if (v && isValidReturnUrl(v)) writes.push([key, v]);
		else errors.push(`${key} must be a site path starting with / or an https URL.`);
	}
	const countriesRaw = typeof values.shippingCountries === "string" ? values.shippingCountries : "";
	const countries = parseCountries(countriesRaw);
	if (countries) writes.push(["shippingCountries", countries.join(",")]);
	else errors.push("Shipping countries must be two-letter codes separated by commas.");

	const shipping = parseAmount(values.flatShipping, currency ?? "USD");
	if (shipping !== undefined) writes.push(["flatShipping", shipping]);
	else errors.push("Flat shipping must be an amount such as 4.99, or empty.");

	const automaticTax = values.automaticTax === true;
	const taxPercent = automaticTax ? 0 : parsePercent(values.flatTaxPercent);
	if (taxPercent !== undefined) writes.push(["flatTaxPercent", taxPercent]);
	else errors.push("Flat tax must be a percent from 0 to 50, such as 8.25, or empty.");
	writes.push(["automaticTax", automaticTax]);

	if (errors.length > 0) {
		const page = await renderSettings(ctx);
		return {
			blocks: [
				{ type: "banner", variant: "error", title: "Not saved", description: errors.join(" ") },
				...page.blocks,
			],
			toast: { message: "Settings not saved", type: "error" },
		};
	}
	try {
		// Secrets first and one at a time: if EmDash cannot encrypt them
		// (no EMDASH_ENCRYPTION_KEY), nothing else is half-saved.
		for (const [k, v] of writes) await ctx.settings.set(k, v);
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		ctx.log.error("Saving settings failed", { message });
		const page = await renderSettings(ctx);
		const description = message.includes("EMDASH_ENCRYPTION_KEY")
			? "EmDash needs EMDASH_ENCRYPTION_KEY set on the site to store the Stripe secrets."
			: "Saving failed. Try again.";
		return {
			blocks: [
				{ type: "banner", variant: "error", title: "Not saved", description },
				...page.blocks,
			],
			toast: { message: "Settings not saved", type: "error" },
		};
	}
	return { ...(await renderSettings(ctx)), toast: { message: "Settings saved", type: "success" } };
}

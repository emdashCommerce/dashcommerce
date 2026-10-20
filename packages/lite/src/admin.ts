/**
 * Block Kit admin: Orders and Settings pages.
 *
 * EmDash posts `page_load`, `block_action` and `form_submit` interactions
 * to the private `admin` route and renders the blocks we return. No
 * browser code ships with the plugin.
 */

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks/server";
import type { PluginContext } from "emdash/plugin";
import { applyStatus, type LiteOrder, ordersStore, updateOrder } from "./orders";
import {
	DEFAULT_CANCEL_URL,
	DEFAULT_CURRENCY,
	DEFAULT_SUCCESS_URL,
	isStripeSecretKey,
	isStripeWebhookSecret,
	isValidReturnUrl,
	normalizeCurrency,
	parseCountries,
} from "./settings";
import { format, type Money, type OrderStatus } from "./shared";
import { asObject, asString } from "./validate";

const PAGE_SIZE = 25;
const ADMIN_STATUSES: OrderStatus[] = ["processing", "on-hold", "completed", "cancelled"];

export async function handleAdmin(ctx: PluginContext, input: unknown): Promise<BlockResponse> {
	const interaction = asObject(input);
	const type = interaction.type;

	if (type === "page_load") {
		const page = asString(interaction.page) ?? "/orders";
		return page === "/settings" ? renderSettings(ctx) : renderOrders(ctx);
	}

	if (type === "block_action") {
		const actionId = asString(interaction.action_id) ?? "";
		const value = interaction.value;
		if (actionId === "view_order" && typeof value === "string") return renderOrder(ctx, value);
		if (actionId === "orders_page") {
			return renderOrders(ctx, typeof value === "string" ? value : undefined);
		}
		if (actionId === "back_to_orders") return renderOrders(ctx);
		if (actionId === "set_status" && typeof value === "string") return setStatus(ctx, value);
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

	if (type === "form_submit" && interaction.action_id === "save_settings") {
		return saveSettings(ctx, asObject(interaction.values));
	}

	return { blocks: [] };
}

// ── Orders ──────────────────────────────────────────────────────────────

function money(m: Money): string {
	return format(m);
}

export async function renderOrders(ctx: PluginContext, cursor?: string): Promise<BlockResponse> {
	const store = ordersStore(ctx);
	const [page, paidCount, pendingCount] = await Promise.all([
		store.query({
			orderBy: { createdAt: "desc" },
			limit: PAGE_SIZE,
			...(cursor ? { cursor } : {}),
		}),
		store.count({ paymentStatus: "paid" }),
		store.count({ status: "pending" }),
	]);
	const blocks: Block[] = [
		{ type: "header", text: "Orders" },
		{
			type: "stats",
			items: [
				{ label: "Paid orders", value: paidCount },
				{ label: "Awaiting payment", value: pendingCount },
			],
		},
		{
			type: "table",
			page_action_id: "orders_page",
			empty_text: "No orders yet",
			columns: [
				{ key: "number", label: "Order", format: "code" },
				{ key: "created", label: "Created", format: "relative_time" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "payment", label: "Payment", format: "badge" },
				{ key: "total", label: "Total" },
				{ key: "email", label: "Customer" },
				{ key: "action", label: "", format: "element" },
			],
			rows: page.items.map(({ id, data }) => ({
				number: data.orderNumber,
				created: data.createdAt,
				status: data.status,
				payment: data.paymentStatus,
				total: money(data.total),
				email: data.customerEmail ?? "",
				action: { type: "button", action_id: "view_order", label: "View", value: id },
			})),
			...(page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
		},
	];
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

function orderBlocks(id: string, o: LiteOrder): Block[] {
	const fields = [
		{ label: "Status", value: o.status },
		{ label: "Payment", value: o.paymentStatus },
		{ label: "Total", value: money(o.total) },
		{ label: "Customer", value: o.customerEmail ?? "Not provided" },
		{ label: "Created", value: o.createdAt },
		{ label: "Paid", value: o.paidAt ?? "Not paid" },
		{ label: "Stripe session", value: o.stripeSessionId ?? "None" },
		{ label: "Payment intent", value: o.stripePaymentIntentId ?? "None" },
	];
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
			description: `Stripe charged ${o.amountMismatch.received.amount} ${o.amountMismatch.received.currency}; the order total is ${money(o.amountMismatch.expected)}. Check the payment in Stripe before fulfilling.`,
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
								text: "This does not refund the payment. Refund it in Stripe first if needed.",
								confirm: "Cancel order",
								deny: "Keep",
								style: "danger" as const,
							},
						}
					: {}),
			})),
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
	return {
		blocks: orderBlocks(id, order),
		toast: written
			? { message: `Order marked ${to}`, type: "success" }
			: { message: `Cannot move a ${order.status} order to ${to}`, type: "error" },
	};
}

// ── Settings ────────────────────────────────────────────────────────────

export async function renderSettings(ctx: PluginContext): Promise<BlockResponse> {
	const [sk, wh, currency, successUrl, cancelUrl, countries] = await Promise.all([
		ctx.settings.get<string>("stripeSecretKey"),
		ctx.settings.get<string>("stripeWebhookSecret"),
		ctx.settings.get<string>("currency"),
		ctx.settings.get<string>("successUrl"),
		ctx.settings.get<string>("cancelUrl"),
		ctx.settings.get<string>("shippingCountries"),
	]);
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
			initial_value: currency ?? DEFAULT_CURRENCY,
		},
		{
			type: "text_input",
			action_id: "successUrl",
			label: "Success URL ({ORDER_ID} and {ORDER_KEY} are replaced)",
			initial_value: successUrl ?? DEFAULT_SUCCESS_URL,
		},
		{
			type: "text_input",
			action_id: "cancelUrl",
			label: "Cancel URL",
			initial_value: cancelUrl ?? DEFAULT_CANCEL_URL,
		},
		{
			type: "text_input",
			action_id: "shippingCountries",
			label:
				"Collect a shipping address for these countries (ISO-2, comma separated; empty = none)",
			initial_value: countries ?? "",
		},
	];
	const blocks: Block[] = [
		{ type: "header", text: "DashCommerce Lite settings" },
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
			text: `Create a Stripe webhook endpoint for this URL and subscribe it to checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed and checkout.session.expired:\n${webhookUrl}`,
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
	const writes: Array<[string, string]> = [];

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

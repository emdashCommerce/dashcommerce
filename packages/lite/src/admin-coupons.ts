/**
 * Block Kit Coupons page: list, create, edit, turn off, delete.
 *
 * Bridge calls per interaction (budget.ts): the list is 1 query; opening a
 * coupon adds its read and, when it has a limit, a count of its uses;
 * saving is a read and a write (or one compare-and-set for a new code)
 * followed by the list. Settings is read once for the store currency.
 */

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks/server";
import type { PluginContext } from "emdash/plugin";
import {
	COUPON_TYPES,
	type CouponType,
	couponsStore,
	countUses,
	describeCoupon,
	type LiteCoupon,
	normalizeCode,
} from "./coupons";
import { formatAmount, type LiteConfig, loadConfig, parseAmount } from "./settings";
import { asInt, asString, type Json } from "./validate";

const PAGE_SIZE = 25;
const MAX_USAGE_LIMIT = 1_000_000;
const NEW = "new";

const TYPE_LABELS: Record<CouponType, string> = {
	percent: "Percentage off the items",
	fixed: "Fixed amount off the items",
	free_shipping: "Free shipping",
};

type Opts = { cursor?: string | undefined; edit?: string };

export async function renderCoupons(
	ctx: PluginContext,
	loaded?: LiteConfig,
	opts: Opts = {},
): Promise<BlockResponse> {
	const config = loaded ?? (await loadConfig(ctx));
	const store = couponsStore(ctx);
	const editing = opts.edit && opts.edit !== NEW ? await store.get(opts.edit) : null;
	const uses = editing?.usageLimit ? await countUses(ctx, editing.code) : null;
	const page = await store.query({
		orderBy: { createdAt: "desc" },
		limit: PAGE_SIZE,
		...(opts.cursor ? { cursor: opts.cursor } : {}),
	});

	const blocks: Block[] = [
		{ type: "header", text: "Coupons" },
		{
			type: "section",
			text: "Shoppers enter a code on the cart. A coupon takes a percentage or a fixed amount off the items, or removes the flat shipping. One coupon per cart. A paid order counts as one use; a fully refunded order gives the use back. Dates are in UTC.",
		},
	];
	if (opts.edit === NEW || editing) {
		blocks.push(...couponForm(config, editing, uses));
	} else {
		blocks.push({
			type: "actions",
			elements: [{ type: "button", action_id: "coupon_new", label: "New coupon" }],
		});
	}
	blocks.push({
		type: "table",
		page_action_id: "coupons_page",
		empty_text: "No coupons yet.",
		columns: [
			{ key: "code", label: "Code", format: "code" },
			{ key: "discount", label: "Discount" },
			{ key: "minimum", label: "Minimum" },
			{ key: "limit", label: "Use limit" },
			{ key: "ends", label: "Ends" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "action", label: "", format: "element" },
		],
		rows: page.items.map(({ id, data }) => ({
			code: data.code,
			discount: describeCoupon(data, formatAmount),
			minimum: data.minSubtotal
				? `${formatAmount(data.minSubtotal, data.currency)} ${data.currency}`
				: "None",
			limit: data.usageLimit ?? "None",
			ends: data.endsAt ? data.endsAt.slice(0, 10) : "Never",
			status: statusOf(data),
			action: { type: "button", action_id: "coupon_edit", label: "Edit", value: id },
		})),
		...(page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
	});
	return { blocks };
}

function statusOf(c: LiteCoupon, now = Date.now()): string {
	if (!c.active) return "Off";
	if (c.startsAt && Date.parse(c.startsAt) > now) return "Scheduled";
	if (c.endsAt && Date.parse(c.endsAt) < now) return "Expired";
	return "Active";
}

function couponForm(config: LiteConfig, c: LiteCoupon | null, uses: number | null): Block[] {
	const currency = c?.currency ?? config.currency;
	const fields: FormField[] = [];
	if (!c) {
		fields.push({
			type: "text_input",
			action_id: "code",
			label: "Code (2 to 32 letters, digits, - or _; not case sensitive)",
			placeholder: "SUMMER10",
		});
	}
	fields.push(
		{
			type: "select",
			action_id: "type",
			label: "Discount",
			options: COUPON_TYPES.map((t) => ({ label: TYPE_LABELS[t], value: t })),
			initial_value: c?.type ?? "percent",
		},
		{
			type: "text_input",
			action_id: "value",
			label: `Percent (1 to 100), or amount in ${currency} for a fixed discount`,
			placeholder: "10",
			initial_value: c ? valueText(c) : "",
			condition: { field: "type", neq: "free_shipping" },
		},
		{
			type: "text_input",
			action_id: "minSubtotal",
			label: `Minimum item subtotal in ${currency} (empty = none)`,
			placeholder: "50.00",
			initial_value: c?.minSubtotal ? formatAmount(c.minSubtotal, currency) : "",
		},
		{
			type: "number_input",
			action_id: "usageLimit",
			label: "Use limit: paid orders that may use it (0 = no limit)",
			initial_value: c?.usageLimit ?? 0,
			min: 0,
			max: MAX_USAGE_LIMIT,
		},
		{
			type: "date_input",
			action_id: "startsAt",
			label: "Starts (UTC, empty = now)",
			...(c?.startsAt ? { initial_value: c.startsAt.slice(0, 10) } : {}),
		},
		{
			type: "date_input",
			action_id: "endsAt",
			label: "Ends after (UTC, empty = never)",
			...(c?.endsAt ? { initial_value: c.endsAt.slice(0, 10) } : {}),
		},
		{
			type: "toggle",
			action_id: "active",
			label: "Active",
			description: "Turn off to stop the code working without deleting it.",
			initial_value: c?.active ?? true,
		},
	);
	const blocks: Block[] = [{ type: "header", text: c ? `Coupon ${c.code}` : "New coupon" }];
	if (c) {
		blocks.push({
			type: "fields",
			fields: [
				{
					label: "Uses",
					value: uses === null ? "Not counted (no limit)" : `${uses} of ${c.usageLimit}`,
				},
				{ label: "Created", value: c.createdAt },
			],
		});
	}
	blocks.push(
		{
			type: "form",
			block_id: `coupon:${c?.code ?? NEW}`,
			fields,
			submit: { label: c ? "Save coupon" : "Create coupon", action_id: "save_coupon" },
		},
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "coupons_page", label: "Cancel", style: "secondary" },
				...(c
					? [
							{
								type: "button" as const,
								action_id: "coupon_delete",
								label: "Delete coupon",
								value: c.code,
								style: "danger" as const,
								confirm: {
									title: `Delete ${c.code}?`,
									text: "Shoppers can no longer use the code. Paid orders keep their discount.",
									confirm: "Delete",
									deny: "Keep",
									style: "danger" as const,
								},
							},
						]
					: []),
			],
		},
	);
	return blocks;
}

function valueText(c: LiteCoupon): string {
	if (c.type === "percent") return String(c.value);
	if (c.type === "fixed") return formatAmount(c.value, c.currency);
	return "";
}

/** "2026-12-31" -> start or end of that UTC day. Undefined for empty, null for invalid. */
export function parseDay(value: unknown, end: boolean): string | undefined | null {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") return null;
	const day = value.trim().slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
	const iso = `${day}T${end ? "23:59:59.999" : "00:00:00.000"}Z`;
	return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Build a coupon from the form. Returns an error message instead when a
 * value is not valid.
 */
export function couponFromForm(
	values: Json,
	currency: string,
	existing: LiteCoupon | null,
	now = Date.now(),
): LiteCoupon | string {
	const code = existing?.code ?? normalizeCode(values.code);
	if (!code) return "Enter a code of 2 to 32 letters, digits, - or _";
	const type = COUPON_TYPES.find((t) => t === values.type);
	if (!type) return "Choose a discount type";
	const cur = existing?.currency ?? currency;
	let value = 0;
	if (type === "percent") {
		const n = asInt(values.value, 1, 100);
		if (n === undefined) return "Enter a whole percent from 1 to 100";
		value = n;
	} else if (type === "fixed") {
		const n = parseAmount(values.value, cur);
		if (!n) return `Enter an amount in ${cur}, for example 5.00`;
		value = n;
	}
	const min = parseAmount(values.minSubtotal, cur);
	if (min === undefined) return `Enter the minimum as an amount in ${cur}, or leave it empty`;
	const limit = values.usageLimit === undefined ? 0 : asInt(values.usageLimit, 0, MAX_USAGE_LIMIT);
	if (limit === undefined) return `Enter a use limit from 0 to ${MAX_USAGE_LIMIT}`;
	const startsAt = parseDay(values.startsAt, false);
	const endsAt = parseDay(values.endsAt, true);
	if (startsAt === null || endsAt === null) return "Enter dates as YYYY-MM-DD";
	if (startsAt && endsAt && endsAt < startsAt) return "The end date is before the start date";
	const at = new Date(now).toISOString();
	return {
		code,
		type,
		value,
		currency: cur,
		active: values.active === undefined ? true : values.active === true,
		...(min ? { minSubtotal: min } : {}),
		...(limit ? { usageLimit: limit } : {}),
		...(startsAt ? { startsAt } : {}),
		...(endsAt ? { endsAt } : {}),
		createdAt: existing?.createdAt ?? at,
		updatedAt: at,
	};
}

export async function saveCoupon(
	ctx: PluginContext,
	blockId: string,
	values: Json,
): Promise<BlockResponse> {
	const config = await loadConfig(ctx);
	const target = blockId.startsWith("coupon:") ? blockId.slice(7) : "";
	const editCode = target && target !== NEW ? normalizeCode(target) : undefined;
	const store = couponsStore(ctx);
	const existing = editCode ? await store.get(editCode) : null;
	if (editCode && !existing) {
		return {
			...(await renderCoupons(ctx, config)),
			toast: { message: "That coupon no longer exists", type: "error" },
		};
	}
	const coupon = couponFromForm(values, config.currency, existing);
	if (typeof coupon === "string") {
		return {
			...(await renderCoupons(ctx, config, { edit: existing?.code ?? NEW })),
			toast: { message: coupon, type: "error" },
		};
	}
	if (existing) {
		await store.put(coupon.code, coupon);
	} else if (!(await store.compareAndSet(coupon.code, null, coupon)).applied) {
		return {
			...(await renderCoupons(ctx, config, { edit: NEW })),
			toast: { message: `A coupon with the code ${coupon.code} already exists`, type: "error" },
		};
	}
	return {
		...(await renderCoupons(ctx, config)),
		toast: { message: `Coupon ${coupon.code} saved`, type: "success" },
	};
}

export async function deleteCoupon(ctx: PluginContext, value: unknown): Promise<BlockResponse> {
	const code = normalizeCode(asString(value, 64));
	const config = await loadConfig(ctx);
	const deleted = code ? await couponsStore(ctx).delete(code) : false;
	return {
		...(await renderCoupons(ctx, config)),
		toast: deleted
			? { message: `Coupon ${code} deleted`, type: "success" }
			: { message: "That coupon no longer exists", type: "error" },
	};
}

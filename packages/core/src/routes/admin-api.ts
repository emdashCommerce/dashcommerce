/**
 * Admin backend API — every page + widget in `admin/entry.tsx` calls
 * routes declared here via `usePluginAPI()` (which auto-prefixes the
 * plugin id). No `public: true` — these routes are admin-auth-gated by
 * the emdash session middleware.
 *
 * Naming: `admin/<resource>[/:id][/:action]`. Path params are parsed out
 * of the request URL since emdash routes match the final path fragment.
 */

import type { PluginContext, RouteContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import { add, money, sub, zero, type Money } from "../money";
import type {
	Coupon,
	Customer,
	Order,
	OrderItem,
	ProductFields,
	Refund,
	Review,
	ShippingClass,
	ShippingMethod,
	ShippingMethodConfig,
	ShippingZone,
	Subscription,
	TaxRate,
	Vendor,
	VendorPayout,
} from "../types";
import { refundOrder } from "../orders/refund";
import { sendReviewRequest } from "../emails";
import { normalizeProductFields } from "../products/normalize";
import { recomputeSummary } from "../reviews/moderate";
import { moderateReview } from "../reviews/moderate";
import { cancel, pause, resume } from "../subscriptions/lifecycle";
import type { StripeClientOptions } from "../stripe/client";
import { call as stripeCall } from "../stripe/client";
import { startOnboarding } from "../vendors/onboarding";
import { syncPayoutsFromStripe } from "../vendors/payouts";
import { assertTransition } from "../orders/status";
import {
	MASKED_SECRET_PREFIX,
	SECRET_SETTINGS_KEYS,
	SETTINGS_KEYS,
	validateSettings,
	validateSettingsKey,
} from "../settings/schema";
import { normalizeCurrencyList } from "../data/currencies";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getCtx(routeCtx: RouteContext, _ctx?: PluginContext): PluginContext {
	return (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
}

function pathParts(req: Request): string[] {
	return new URL(req.url).pathname.split("/").filter(Boolean);
}

function lastAfter(parts: string[], token: string, offset = 1): string | undefined {
	const idx = parts.lastIndexOf(token);
	return idx === -1 ? undefined : parts[idx + offset];
}

/**
 * Read a query parameter, falling back to the path segment that follows
 * `token` for backward compatibility with any lingering clients that still
 * use REST-style `/admin/…/:id[/…]` URLs.
 *
 * Emdash's plugin route registry performs an exact match on the full path,
 * so the static keys below (e.g. `admin/orders/refund`) do not naturally
 * match path-parameterised URLs. New callers must pass `?id=…`; the path
 * fallback is a safety net and is expected to be a dead-code branch.
 */
function queryOrPath(
	req: Request,
	queryKey: string,
	pathToken: string,
	offset = 1,
): string | undefined {
	const url = new URL(req.url);
	const q = url.searchParams.get(queryKey);
	if (q && q.length > 0) return q;
	return lastAfter(pathParts(req), pathToken, offset);
}

async function loadStripeClient(ctx: PluginContext): Promise<StripeClientOptions | null> {
	const secret = await ctx.kv.get<string>("settings:stripeSecretKey");
	if (!secret) return null;
	return { secretKey: secret };
}

async function requireConnectEnabled(ctx: PluginContext): Promise<boolean> {
	return (await ctx.kv.get<boolean>("settings:connectEnabled")) === true;
}

function connectOffResponse(): Response {
	return json(
		{
			error: "marketplace_disabled",
			message:
				"Multi-vendor marketplace is disabled. Enable Stripe Connect in Settings to use vendor routes.",
		},
		409,
	);
}

function storeOf<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	return (ctx.storage as unknown as Record<string, StorageCollection<T>>)[name] as StorageCollection<T>;
}

// ────────────────────────────────────────────────────────────────────────────
// Settings — GET/POST with secret masking (validation lives in settings/schema)
// ────────────────────────────────────────────────────────────────────────────

function secretHint(value: unknown): string {
	if (typeof value !== "string" || value.length < 4) return MASKED_SECRET_PREFIX;
	return `${MASKED_SECRET_PREFIX}${value.slice(-4)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────────────────────────

async function queryOrders(
	ctx: PluginContext,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const status = url.searchParams.get("status");
	const paymentStatus = url.searchParams.get("paymentStatus");
	const currency = url.searchParams.get("currency");
	const email = url.searchParams.get("email")?.trim().toLowerCase();
	const from = url.searchParams.get("from");
	const to = url.searchParams.get("to");
	const minTotalRaw = url.searchParams.get("minTotal");
	const maxTotalRaw = url.searchParams.get("maxTotal");
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limit = Math.min(
		100,
		Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
	);

	// Indexed filters go through `where` so the storage engine can use the
	// index; free-form filters (email, currency, total range, date range)
	// are applied post-fetch since they're not part of the storage schema.
	const where: Record<string, string | { gte?: string; lte?: string }> = {};
	if (status) where.status = status;
	if (paymentStatus) where.paymentStatus = paymentStatus;
	if (from || to) {
		const range: { gte?: string; lte?: string } = {};
		if (from) range.gte = from;
		// Date-only `to` ("2026-04-19") would exclude same-day orders whose
		// ISO createdAt includes a time component. Extend to end of day.
		if (to) range.lte = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;
		where.createdAt = range;
	}

	const result = await storeOf<Order>(ctx, "orders").query({
		where,
		orderBy: { createdAt: "desc" },
		limit,
		...(cursor ? { cursor } : {}),
	});
	let items = result.items.map((r) => ({ ...(r.data as Order), id: r.id }));
	if (currency) items = items.filter((o) => o.currency === currency);
	if (email) {
		items = items.filter((o) => o.customerEmail.toLowerCase().includes(email));
	}
	const minTotal = minTotalRaw ? Number.parseInt(minTotalRaw, 10) : null;
	const maxTotal = maxTotalRaw ? Number.parseInt(maxTotalRaw, 10) : null;
	if (Number.isFinite(minTotal ?? NaN)) {
		items = items.filter((o) => o.total.amount >= (minTotal ?? 0));
	}
	if (Number.isFinite(maxTotal ?? NaN)) {
		items = items.filter((o) => o.total.amount <= (maxTotal ?? 0));
	}
	return json({ items, cursor: result.cursor, hasMore: result.hasMore });
}

async function getOrderDetail(
	ctx: PluginContext,
	orderId: string,
): Promise<Response> {
	const order = await storeOf<Order>(ctx, "orders").get(orderId);
	if (!order) return json({ error: "Order not found" }, 404);
	const items = (
		await storeOf<OrderItem>(ctx, "order_items").query({
			where: { orderId },
			limit: 200,
		})
	).items.map((r) => ({ ...(r.data as OrderItem), id: r.id }));
	const refunds = (
		await storeOf<Refund>(ctx, "refunds").query({
			where: { orderId },
			limit: 100,
		})
	).items.map((r) => ({ ...(r.data as Refund), id: r.id }));
	return json({ order: { ...order, id: orderId }, items, refunds });
}

async function postOrderRefund(
	ctx: PluginContext,
	orderId: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const client = await loadStripeClient(ctx);
	if (!client) return json({ error: "Stripe not configured" }, 500);
	const input = (routeCtx.input ?? {}) as {
		amount?: number;
		currency?: string;
		reason?: string;
		restock?: boolean;
		lineItemRefunds?: Array<{ orderItemId: string; quantity: number; amount: number; currency: string }>;
	};
	if (typeof input.amount !== "number" || !input.currency) {
		return json({ error: "amount (minor units) and currency required" }, 400);
	}
	try {
		const refund = await refundOrder(ctx, {
			orderId,
			amount: money(input.currency, input.amount),
			...(input.reason ? { reason: input.reason } : {}),
			...(input.restock ? { restock: true } : {}),
			...(input.lineItemRefunds
				? {
						lineItemRefunds: input.lineItemRefunds.map((li) => ({
							orderItemId: li.orderItemId,
							quantity: li.quantity,
							amount: money(li.currency, li.amount),
						})),
					}
				: {}),
			client,
			idempotencyKey: `refund:${orderId}:${randomId()}`,
		});
		return json({ refund });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : "Refund failed" },
			400,
		);
	}
}

async function postOrderStatus(
	ctx: PluginContext,
	orderId: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const body = (routeCtx.input ?? {}) as { status?: Order["status"] };
	if (!body.status) return json({ error: "status required" }, 400);
	const order = await storeOf<Order>(ctx, "orders").get(orderId);
	if (!order) return json({ error: "Order not found" }, 404);
	try {
		assertTransition(order.status, body.status);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : "Invalid transition" },
			400,
		);
	}
	const updated: Order = {
		...order,
		status: body.status,
		updatedAt: new Date().toISOString(),
		...(body.status === "completed" ? { completedAt: new Date().toISOString() } : {}),
		...(body.status === "cancelled" ? { cancelledAt: new Date().toISOString() } : {}),
	};
	await storeOf<Order>(ctx, "orders").put(orderId, updated);

	// On fulfilment flip, queue a post-purchase review request. Best-effort
	// and rate-limited inside `sendReviewRequest` via a KV marker, so a
	// merchant flipping statuses back and forth won't cause duplicate sends.
	if (order.status !== "completed" && body.status === "completed") {
		try {
			const items = await loadOrderItems(ctx, orderId);
			// Best guess at product permalinks — the host site decides the
			// actual URL shape. `/product/{slug}` is the starter default;
			// merchants with a different scheme can override via settings
			// later (out of scope for phase 15).
			await sendReviewRequest(ctx, updated, items, (it) =>
				ctx.url(`/product/${encodeURIComponent(it.productId)}`),
			);
		} catch (err) {
			ctx.log.warn("review-request send skipped", {
				orderId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return json({ order: updated });
}

async function loadOrderItems(
	ctx: PluginContext,
	orderId: string,
): Promise<OrderItem[]> {
	const res = await storeOf<OrderItem>(ctx, "order_items").query({
		where: { orderId },
		limit: 200,
	});
	return res.items.map((r) => ({ ...(r.data as OrderItem), id: r.id }));
}

async function queryCustomers(
	ctx: PluginContext,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const search = url.searchParams.get("search")?.trim().toLowerCase();
	const guestFilter = url.searchParams.get("guest"); // "true" | "false" | null
	const from = url.searchParams.get("from");
	const to = url.searchParams.get("to");
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limit = Math.min(
		200,
		Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100),
	);

	const where: Record<string, string | { gte?: string; lte?: string }> = {};
	if (from || to) {
		const range: { gte?: string; lte?: string } = {};
		if (from) range.gte = from;
		if (to) range.lte = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;
		where.createdAt = range;
	}

	const result = await storeOf<Customer>(ctx, "customers").query({
		where,
		orderBy: { createdAt: "desc" },
		limit,
		...(cursor ? { cursor } : {}),
	});
	let items = result.items.map((r) => ({ ...(r.data as Customer), id: r.id }));
	if (search) {
		items = items.filter(
			(c) =>
				c.email.toLowerCase().includes(search) ||
				(c.firstName ?? "").toLowerCase().includes(search) ||
				(c.lastName ?? "").toLowerCase().includes(search),
		);
	}
	if (guestFilter === "true") items = items.filter((c) => !c.userId);
	if (guestFilter === "false") items = items.filter((c) => Boolean(c.userId));
	return json({ items, cursor: result.cursor, hasMore: result.hasMore });
}

async function getCustomerDetail(
	ctx: PluginContext,
	customerId: string,
): Promise<Response> {
	const customer = await storeOf<Customer>(ctx, "customers").get(customerId);
	if (!customer) return json({ error: "Customer not found" }, 404);
	const [orders, subs] = await Promise.all([
		storeOf<Order>(ctx, "orders").query({
			where: { customerId },
			orderBy: { createdAt: "desc" },
			limit: 50,
		}),
		storeOf<Subscription>(ctx, "subscriptions").query({
			where: { customerId },
			limit: 50,
		}),
	]);
	return json({
		customer: { ...customer, id: customerId },
		orders: orders.items.map((r) => ({ ...(r.data as Order), id: r.id })),
		subscriptions: subs.items.map((r) => ({
			...(r.data as Subscription),
			id: r.id,
		})),
	});
}

async function listCoupons(ctx: PluginContext, req: Request): Promise<Response> {
	const url = new URL(req.url);
	const status = url.searchParams.get("status");
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const result = await storeOf<Coupon>(ctx, "coupons").query({
		...(status ? { where: { status } } : {}),
		orderBy: { createdAt: "desc" },
		limit: 100,
		...(cursor ? { cursor } : {}),
	});
	return json({
		items: result.items.map((r) => ({ ...(r.data as Coupon), id: r.id })),
		cursor: result.cursor,
		hasMore: result.hasMore,
	});
}

async function upsertCoupon(
	ctx: PluginContext,
	input: Partial<Coupon> & { code: string },
	couponId?: string,
): Promise<Coupon> {
	const now = new Date().toISOString();
	const id = couponId ?? randomId();
	const existing = couponId
		? await storeOf<Coupon>(ctx, "coupons").get(couponId)
		: null;
	const record: Coupon = {
		id,
		code: input.code.toUpperCase(),
		...(input.description ? { description: input.description } : {}),
		discountType: input.discountType ?? existing?.discountType ?? "percent_cart",
		discountValue: input.discountValue ?? existing?.discountValue ?? 0,
		...(input.currency ? { currency: input.currency } : {}),
		status: input.status ?? existing?.status ?? "active",
		...(input.startsAt ? { startsAt: input.startsAt } : {}),
		...(input.endsAt ? { endsAt: input.endsAt } : {}),
		...(input.minAmount ? { minAmount: input.minAmount } : {}),
		...(input.maxAmount ? { maxAmount: input.maxAmount } : {}),
		...(input.includedProductIds
			? { includedProductIds: input.includedProductIds }
			: {}),
		...(input.excludedProductIds
			? { excludedProductIds: input.excludedProductIds }
			: {}),
		excludeSaleItems: input.excludeSaleItems ?? false,
		...(input.usageLimit !== undefined ? { usageLimit: input.usageLimit } : {}),
		...(input.usageLimitPerCustomer !== undefined
			? { usageLimitPerCustomer: input.usageLimitPerCustomer }
			: {}),
		usageCount: existing?.usageCount ?? 0,
		individualUse: input.individualUse ?? existing?.individualUse ?? false,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	await storeOf<Coupon>(ctx, "coupons").put(id, record);
	return record;
}

async function listShippingZones(ctx: PluginContext): Promise<Response> {
	const zones = await storeOf<ShippingZone>(ctx, "shipping_zones").query({
		orderBy: { order: "asc" },
		limit: 200,
	});
	const methods = await storeOf<ShippingMethod>(ctx, "shipping_methods").query({
		limit: 500,
	});
	const classes = await storeOf<ShippingClass>(ctx, "shipping_classes").query({
		limit: 100,
	});
	return json({
		zones: zones.items.map((r) => ({ ...(r.data as ShippingZone), id: r.id })),
		methods: methods.items.map((r) => ({
			...(r.data as ShippingMethod),
			id: r.id,
		})),
		classes: classes.items.map((r) => ({
			...(r.data as ShippingClass),
			id: r.id,
		})),
	});
}

async function listTaxRates(ctx: PluginContext): Promise<Response> {
	const result = await storeOf<TaxRate>(ctx, "tax_rates").query({
		orderBy: { priority: "asc" },
		limit: 500,
	});
	return json({
		items: result.items.map((r) => ({ ...(r.data as TaxRate), id: r.id })),
	});
}

function validateTaxRateInput(
	input: Record<string, unknown>,
	partial = false,
): { ok: true; value: Partial<TaxRate> } | { ok: false; error: string } {
	const out: Partial<TaxRate> = {};
	if (!partial || input.country !== undefined) {
		if (typeof input.country !== "string" || !/^[A-Z]{2}$/.test(input.country)) {
			return { ok: false, error: "country must be a 2-letter ISO-3166 code" };
		}
		out.country = input.country as TaxRate["country"];
	}
	if (input.region !== undefined && input.region !== null) {
		if (typeof input.region !== "string") {
			return { ok: false, error: "region must be a string" };
		}
		out.region = input.region as TaxRate["region"];
	}
	if (input.postalCode !== undefined && input.postalCode !== null) {
		if (typeof input.postalCode !== "string") {
			return { ok: false, error: "postalCode must be a string" };
		}
		out.postalCode = input.postalCode;
	}
	if (!partial || input.taxClass !== undefined) {
		if (typeof input.taxClass !== "string" || input.taxClass.trim() === "") {
			return { ok: false, error: "taxClass is required" };
		}
		out.taxClass = input.taxClass.trim();
	}
	if (!partial || input.rate !== undefined) {
		if (
			typeof input.rate !== "number" ||
			!Number.isFinite(input.rate) ||
			input.rate < 0 ||
			input.rate > 100
		) {
			return { ok: false, error: "rate must be a number between 0 and 100" };
		}
		out.rate = input.rate;
	}
	if (!partial || input.name !== undefined) {
		if (typeof input.name !== "string" || input.name.trim() === "") {
			return { ok: false, error: "name is required" };
		}
		out.name = input.name.trim();
	}
	if (input.compound !== undefined) {
		if (typeof input.compound !== "boolean") {
			return { ok: false, error: "compound must be a boolean" };
		}
		out.compound = input.compound;
	}
	if (input.appliesToShipping !== undefined) {
		if (typeof input.appliesToShipping !== "boolean") {
			return { ok: false, error: "appliesToShipping must be a boolean" };
		}
		out.appliesToShipping = input.appliesToShipping;
	}
	if (input.priority !== undefined) {
		if (
			typeof input.priority !== "number" ||
			!Number.isFinite(input.priority) ||
			!Number.isInteger(input.priority)
		) {
			return { ok: false, error: "priority must be an integer" };
		}
		out.priority = input.priority;
	}
	return { ok: true, value: out };
}

async function postTaxRate(
	ctx: PluginContext,
	routeCtx: RouteContext,
): Promise<Response> {
	const input = (routeCtx.input ?? {}) as Record<string, unknown>;
	const validated = validateTaxRateInput(input);
	if (!validated.ok) return json({ error: validated.error }, 400);
	const id = randomId();
	const row: TaxRate = {
		id,
		country: validated.value.country as TaxRate["country"],
		...(validated.value.region ? { region: validated.value.region } : {}),
		...(validated.value.postalCode ? { postalCode: validated.value.postalCode } : {}),
		taxClass: validated.value.taxClass as string,
		rate: validated.value.rate as number,
		name: validated.value.name as string,
		compound: validated.value.compound ?? false,
		appliesToShipping: validated.value.appliesToShipping ?? false,
		priority: validated.value.priority ?? 0,
	};
	await storeOf<TaxRate>(ctx, "tax_rates").put(id, row);
	return json({ rate: row }, 201);
}

async function patchTaxRate(
	ctx: PluginContext,
	id: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const store = storeOf<TaxRate>(ctx, "tax_rates");
	const current = (await store.get(id)) as TaxRate | null;
	if (!current) return json({ error: "Tax rate not found" }, 404);
	const input = (routeCtx.input ?? {}) as Record<string, unknown>;
	const validated = validateTaxRateInput(input, true);
	if (!validated.ok) return json({ error: validated.error }, 400);
	const next: TaxRate = { ...current, ...validated.value, id };
	await store.put(id, next);
	return json({ rate: next });
}

async function deleteTaxRate(ctx: PluginContext, id: string): Promise<Response> {
	const store = storeOf<TaxRate>(ctx, "tax_rates");
	const current = await store.get(id);
	if (!current) return json({ error: "Tax rate not found" }, 404);
	await store.delete(id);
	return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────────────────
// Shipping CRUD
// ────────────────────────────────────────────────────────────────────────────

function validateShippingZone(
	input: Record<string, unknown>,
	partial = false,
): { ok: true; value: Partial<ShippingZone> } | { ok: false; error: string } {
	const out: Partial<ShippingZone> = {};
	if (!partial || input.name !== undefined) {
		if (typeof input.name !== "string" || input.name.trim() === "") {
			return { ok: false, error: "name is required" };
		}
		out.name = input.name.trim();
	}
	if (!partial || input.locations !== undefined) {
		if (!Array.isArray(input.locations)) {
			return { ok: false, error: "locations must be an array" };
		}
		const locations: Array<{ country: string; regions?: string[] }> = [];
		for (const loc of input.locations) {
			if (
				!loc ||
				typeof loc !== "object" ||
				typeof (loc as { country?: unknown }).country !== "string"
			) {
				return { ok: false, error: "each location needs a country code" };
			}
			const l = loc as { country: string; regions?: unknown };
			if (!/^[A-Z]{2}$/.test(l.country)) {
				return {
					ok: false,
					error: `country must be a 2-letter ISO-3166 code (got '${l.country}')`,
				};
			}
			if (l.regions !== undefined) {
				if (
					!Array.isArray(l.regions) ||
					l.regions.some((r) => typeof r !== "string")
				) {
					return { ok: false, error: "regions must be an array of strings" };
				}
				locations.push({ country: l.country, regions: l.regions as string[] });
			} else {
				locations.push({ country: l.country });
			}
		}
		out.locations = locations;
	}
	if (input.order !== undefined) {
		if (
			typeof input.order !== "number" ||
			!Number.isFinite(input.order) ||
			!Number.isInteger(input.order)
		) {
			return { ok: false, error: "order must be an integer" };
		}
		out.order = input.order;
	}
	return { ok: true, value: out };
}

async function postShippingZone(
	ctx: PluginContext,
	routeCtx: RouteContext,
): Promise<Response> {
	const input = (routeCtx.input ?? {}) as Record<string, unknown>;
	const v = validateShippingZone(input);
	if (!v.ok) return json({ error: v.error }, 400);
	const id = randomId();
	const now = new Date().toISOString();
	const row: ShippingZone = {
		id,
		name: v.value.name as string,
		locations: v.value.locations ?? [],
		order: v.value.order ?? 0,
		createdAt: now,
		updatedAt: now,
	};
	await storeOf<ShippingZone>(ctx, "shipping_zones").put(id, row);
	return json({ zone: row }, 201);
}

async function patchShippingZone(
	ctx: PluginContext,
	id: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const store = storeOf<ShippingZone>(ctx, "shipping_zones");
	const current = (await store.get(id)) as ShippingZone | null;
	if (!current) return json({ error: "Zone not found" }, 404);
	const input = (routeCtx.input ?? {}) as Record<string, unknown>;
	const v = validateShippingZone(input, true);
	if (!v.ok) return json({ error: v.error }, 400);
	const next: ShippingZone = {
		...current,
		...v.value,
		id,
		updatedAt: new Date().toISOString(),
	};
	await store.put(id, next);
	return json({ zone: next });
}

async function deleteShippingZone(
	ctx: PluginContext,
	id: string,
): Promise<Response> {
	const store = storeOf<ShippingZone>(ctx, "shipping_zones");
	const current = await store.get(id);
	if (!current) return json({ error: "Zone not found" }, 404);
	// Zones own methods; fail fast if any method still references this zone
	// rather than leaving orphaned methods in the store.
	const methods = await storeOf<ShippingMethod>(ctx, "shipping_methods").query({
		where: { zoneId: id },
		limit: 1,
	});
	if (methods.items.length > 0) {
		return json(
			{
				error:
					"Zone still has methods — delete the methods first or move them to another zone.",
			},
			409,
		);
	}
	await store.delete(id);
	return json({ ok: true });
}

function validateShippingMethod(
	input: Record<string, unknown>,
	partial = false,
): { ok: true; value: Partial<ShippingMethod> } | { ok: false; error: string } {
	const out: Partial<ShippingMethod> = {};
	if (!partial || input.zoneId !== undefined) {
		if (typeof input.zoneId !== "string" || input.zoneId.trim() === "") {
			return { ok: false, error: "zoneId is required" };
		}
		out.zoneId = input.zoneId;
	}
	if (!partial || input.title !== undefined) {
		if (typeof input.title !== "string" || input.title.trim() === "") {
			return { ok: false, error: "title is required" };
		}
		out.title = input.title.trim();
	}
	if (!partial || input.type !== undefined) {
		if (
			input.type !== "flat_rate" &&
			input.type !== "free_shipping" &&
			input.type !== "local_pickup" &&
			input.type !== "weight_based"
		) {
			return {
				ok: false,
				error:
					"type must be one of flat_rate | free_shipping | local_pickup | weight_based",
			};
		}
		out.type = input.type;
	}
	if (input.enabled !== undefined) {
		if (typeof input.enabled !== "boolean") {
			return { ok: false, error: "enabled must be a boolean" };
		}
		out.enabled = input.enabled;
	}
	if (input.order !== undefined) {
		if (
			typeof input.order !== "number" ||
			!Number.isFinite(input.order) ||
			!Number.isInteger(input.order)
		) {
			return { ok: false, error: "order must be an integer" };
		}
		out.order = input.order;
	}
	if (!partial || input.config !== undefined) {
		if (input.config === null || typeof input.config !== "object") {
			return { ok: false, error: "config is required" };
		}
		out.config = input.config as ShippingMethodConfig;
	}
	return { ok: true, value: out };
}

async function postShippingMethod(
	ctx: PluginContext,
	routeCtx: RouteContext,
): Promise<Response> {
	const input = (routeCtx.input ?? {}) as Record<string, unknown>;
	const v = validateShippingMethod(input);
	if (!v.ok) return json({ error: v.error }, 400);
	const id = randomId();
	const row: ShippingMethod = {
		id,
		zoneId: v.value.zoneId as string,
		title: v.value.title as string,
		type: v.value.type as ShippingMethod["type"],
		enabled: v.value.enabled ?? true,
		order: v.value.order ?? 0,
		config: v.value.config as ShippingMethodConfig,
	};
	await storeOf<ShippingMethod>(ctx, "shipping_methods").put(id, row);
	return json({ method: row }, 201);
}

async function patchShippingMethod(
	ctx: PluginContext,
	id: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const store = storeOf<ShippingMethod>(ctx, "shipping_methods");
	const current = (await store.get(id)) as ShippingMethod | null;
	if (!current) return json({ error: "Method not found" }, 404);
	const input = (routeCtx.input ?? {}) as Record<string, unknown>;
	const v = validateShippingMethod(input, true);
	if (!v.ok) return json({ error: v.error }, 400);
	const next: ShippingMethod = { ...current, ...v.value, id };
	await store.put(id, next);
	return json({ method: next });
}

async function deleteShippingMethod(
	ctx: PluginContext,
	id: string,
): Promise<Response> {
	const store = storeOf<ShippingMethod>(ctx, "shipping_methods");
	const current = await store.get(id);
	if (!current) return json({ error: "Method not found" }, 404);
	await store.delete(id);
	return json({ ok: true });
}

function validateShippingClass(
	input: Record<string, unknown>,
	partial = false,
): { ok: true; value: Partial<ShippingClass> } | { ok: false; error: string } {
	const out: Partial<ShippingClass> = {};
	if (!partial || input.slug !== undefined) {
		if (typeof input.slug !== "string" || input.slug.trim() === "") {
			return { ok: false, error: "slug is required" };
		}
		if (!/^[a-z0-9][a-z0-9-_]*$/i.test(input.slug.trim())) {
			return {
				ok: false,
				error: "slug must be alphanumeric (plus - and _)",
			};
		}
		out.slug = input.slug.trim().toLowerCase();
	}
	if (!partial || input.name !== undefined) {
		if (typeof input.name !== "string" || input.name.trim() === "") {
			return { ok: false, error: "name is required" };
		}
		out.name = input.name.trim();
	}
	if (input.description !== undefined && input.description !== null) {
		if (typeof input.description !== "string") {
			return { ok: false, error: "description must be a string" };
		}
		out.description = input.description;
	}
	return { ok: true, value: out };
}

async function postShippingClass(
	ctx: PluginContext,
	routeCtx: RouteContext,
): Promise<Response> {
	const input = (routeCtx.input ?? {}) as Record<string, unknown>;
	const v = validateShippingClass(input);
	if (!v.ok) return json({ error: v.error }, 400);
	const id = randomId();
	const row: ShippingClass = {
		id,
		slug: v.value.slug as string,
		name: v.value.name as string,
		...(v.value.description !== undefined
			? { description: v.value.description }
			: {}),
	};
	try {
		await storeOf<ShippingClass>(ctx, "shipping_classes").put(id, row);
	} catch (err) {
		// Unique index violation on `slug` lands here.
		return json(
			{
				error: err instanceof Error ? err.message : "Could not create class",
			},
			409,
		);
	}
	return json({ class: row }, 201);
}

async function patchShippingClass(
	ctx: PluginContext,
	id: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const store = storeOf<ShippingClass>(ctx, "shipping_classes");
	const current = (await store.get(id)) as ShippingClass | null;
	if (!current) return json({ error: "Class not found" }, 404);
	const input = (routeCtx.input ?? {}) as Record<string, unknown>;
	const v = validateShippingClass(input, true);
	if (!v.ok) return json({ error: v.error }, 400);
	const next: ShippingClass = { ...current, ...v.value, id };
	try {
		await store.put(id, next);
	} catch (err) {
		return json(
			{
				error: err instanceof Error ? err.message : "Could not update class",
			},
			409,
		);
	}
	return json({ class: next });
}

async function deleteShippingClass(
	ctx: PluginContext,
	id: string,
): Promise<Response> {
	const store = storeOf<ShippingClass>(ctx, "shipping_classes");
	const current = await store.get(id);
	if (!current) return json({ error: "Class not found" }, 404);
	await store.delete(id);
	return json({ ok: true });
}

async function listSubscriptions(
	ctx: PluginContext,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const status = url.searchParams.get("status");
	const email = url.searchParams.get("email")?.trim().toLowerCase();
	const productId = url.searchParams.get("productId");
	const from = url.searchParams.get("from");
	const to = url.searchParams.get("to");
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limit = Math.min(
		100,
		Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
	);

	const where: Record<string, string | { gte?: string; lte?: string }> = {};
	if (status) where.status = status;
	if (from || to) {
		const range: { gte?: string; lte?: string } = {};
		if (from) range.gte = from;
		if (to) range.lte = to;
		where.createdAt = range;
	}

	const result = await storeOf<Subscription>(ctx, "subscriptions").query({
		where,
		orderBy: { createdAt: "desc" },
		limit,
		...(cursor ? { cursor } : {}),
	});
	let items = result.items.map((r) => ({
		...(r.data as Subscription),
		id: r.id,
	}));
	if (productId) items = items.filter((s) => s.productId === productId);
	if (email) {
		// Email lookup requires joining customers; fetch the affected set
		// lazily to avoid a full customer scan.
		const customerIds = Array.from(new Set(items.map((s) => s.customerId)));
		const customers = await Promise.all(
			customerIds.map(async (id) => {
				const c = await storeOf<Customer>(ctx, "customers").get(id);
				return [id, c?.email?.toLowerCase() ?? ""] as const;
			}),
		);
		const emailById = new Map(customers);
		items = items.filter((s) =>
			(emailById.get(s.customerId) ?? "").includes(email),
		);
	}
	return json({ items, cursor: result.cursor, hasMore: result.hasMore });
}

async function postSubscriptionAction(
	ctx: PluginContext,
	subscriptionId: string,
	action: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const client = await loadStripeClient(ctx);
	if (!client) return json({ error: "Stripe not configured" }, 500);
	const body = (routeCtx.input ?? {}) as {
		mode?: "immediate" | "at_period_end";
		resumesAt?: number;
	};
	try {
		if (action === "cancel") {
			const updated = await cancel(ctx, {
				subscriptionId,
				mode: body.mode ?? "at_period_end",
				client,
			});
			return json({ stripeStatus: updated.status });
		}
		if (action === "pause") {
			const updated = await pause(ctx, {
				subscriptionId,
				...(body.resumesAt !== undefined ? { resumesAt: body.resumesAt } : {}),
				client,
			});
			return json({ stripeStatus: updated.status });
		}
		if (action === "resume") {
			const updated = await resume(ctx, { subscriptionId, client });
			return json({ stripeStatus: updated.status });
		}
		return json({ error: `Unknown action ${action}` }, 400);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : "Action failed" },
			500,
		);
	}
}

async function listReviews(ctx: PluginContext, req: Request): Promise<Response> {
	const url = new URL(req.url);
	const status = url.searchParams.get("status") ?? "pending";
	const productId = url.searchParams.get("productId");
	const ratingRaw = url.searchParams.get("rating");
	const verifiedOnly = url.searchParams.get("verifiedOnly") === "true";
	const from = url.searchParams.get("from");
	const to = url.searchParams.get("to");
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limit = Math.min(
		100,
		Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
	);

	const where: Record<string, string | { gte?: string; lte?: string }> = {
		status,
	};
	if (productId) where.productId = productId;
	if (from || to) {
		const range: { gte?: string; lte?: string } = {};
		if (from) range.gte = from;
		if (to) range.lte = to;
		where.createdAt = range;
	}

	const result = await storeOf<Review>(ctx, "reviews").query({
		where,
		orderBy: { createdAt: "desc" },
		limit,
		...(cursor ? { cursor } : {}),
	});
	let items = result.items.map((r) => ({ ...(r.data as Review), id: r.id }));
	const rating = ratingRaw ? Number.parseInt(ratingRaw, 10) : null;
	if (rating && rating >= 1 && rating <= 5) {
		items = items.filter((r) => r.rating === rating);
	}
	if (verifiedOnly) items = items.filter((r) => r.verifiedPurchase);
	return json({ items, cursor: result.cursor, hasMore: result.hasMore });
}

async function postReviewModerate(
	ctx: PluginContext,
	reviewId: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const body = (routeCtx.input ?? {}) as {
		status?: Review["status"];
		moderatedByUserId?: string;
	};
	if (!body.status) return json({ error: "status required" }, 400);
	try {
		const updated = await moderateReview(
			ctx,
			reviewId,
			body.status,
			body.moderatedByUserId,
		);
		if (body.status === "approved" || updated.status === "approved") {
			await recomputeSummary(ctx, updated.productId);
		}
		return json({ review: updated });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : "Moderation failed" },
			500,
		);
	}
}

async function listVendors(ctx: PluginContext, req: Request): Promise<Response> {
	const url = new URL(req.url);
	const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
	const status = url.searchParams.get("status");
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limit = Math.min(
		200,
		Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
	);
	const where: Record<string, string> = {};
	if (status) where.onboardingStatus = status;
	const result = await storeOf<Vendor>(ctx, "vendors").query({
		where,
		orderBy: { createdAt: "desc" },
		limit,
		...(cursor ? { cursor } : {}),
	});
	let items = result.items.map((r) => ({ ...(r.data as Vendor), id: r.id }));
	if (q) {
		items = items.filter(
			(v) =>
				v.name.toLowerCase().includes(q) ||
				v.email.toLowerCase().includes(q) ||
				v.stripeAccountId.toLowerCase().includes(q),
		);
	}
	return json({ items, cursor: result.cursor, hasMore: result.hasMore });
}

async function patchVendor(
	ctx: PluginContext,
	vendorId: string,
	routeCtx: RouteContext,
): Promise<Response> {
	const store = storeOf<Vendor>(ctx, "vendors");
	const current = (await store.get(vendorId)) as Vendor | null;
	if (!current) return json({ error: "Vendor not found" }, 404);
	const input = (routeCtx.input ?? {}) as {
		name?: string;
		platformFeePercent?: number;
	};
	const patch: Partial<Vendor> = {};
	if (typeof input.name === "string") {
		const trimmed = input.name.trim();
		if (!trimmed) return json({ error: "Name cannot be empty" }, 400);
		patch.name = trimmed;
	}
	if (input.platformFeePercent !== undefined) {
		const fee = input.platformFeePercent;
		if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0 || fee > 100) {
			return json({ error: "platformFeePercent must be between 0 and 100" }, 400);
		}
		patch.platformFeePercent = fee;
	}
	if (Object.keys(patch).length === 0) {
		return json({ error: "No updatable fields provided" }, 400);
	}
	const next: Vendor = {
		...current,
		...patch,
		updatedAt: new Date().toISOString(),
	};
	await store.put(vendorId, next);
	return json({ vendor: { ...next, id: vendorId } });
}

async function refreshVendorFromStripe(
	ctx: PluginContext,
	vendorId: string,
): Promise<Response> {
	const client = await loadStripeClient(ctx);
	if (!client) return json({ error: "Stripe not configured" }, 500);
	const store = storeOf<Vendor>(ctx, "vendors");
	const current = (await store.get(vendorId)) as Vendor | null;
	if (!current) return json({ error: "Vendor not found" }, 404);
	try {
		const account = await stripeCall<{
			id: string;
			details_submitted?: boolean;
			charges_enabled?: boolean;
			payouts_enabled?: boolean;
		}>(ctx, {
			method: "GET",
			path: `/accounts/${current.stripeAccountId}`,
			client,
		});
		const onboardingStatus: Vendor["onboardingStatus"] = account.charges_enabled
			? "active"
			: account.details_submitted
				? "restricted"
				: "pending";
		const next: Vendor = {
			...current,
			detailsSubmitted: !!account.details_submitted,
			chargesEnabled: !!account.charges_enabled,
			payoutsEnabled: !!account.payouts_enabled,
			onboardingStatus,
			updatedAt: new Date().toISOString(),
		};
		await store.put(vendorId, next);
		return json({ vendor: { ...next, id: vendorId } });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : "Stripe refresh failed" },
			502,
		);
	}
}

async function postVendorOnboardLink(
	ctx: PluginContext,
	routeCtx: RouteContext,
): Promise<Response> {
	const client = await loadStripeClient(ctx);
	if (!client) return json({ error: "Stripe not configured" }, 500);
	const body = (routeCtx.input ?? {}) as {
		vendorId?: string;
		email?: string;
		name?: string;
		country?: string;
		platformFeePercent?: number;
		refreshUrl?: string;
		returnUrl?: string;
	};
	if (!body.email || !body.name || !body.refreshUrl || !body.returnUrl) {
		return json(
			{ error: "email, name, refreshUrl, returnUrl are required" },
			400,
		);
	}
	const result = await startOnboarding(ctx, {
		...(body.vendorId ? { vendorId: body.vendorId } : {}),
		email: body.email,
		name: body.name,
		...(body.country ? { country: body.country } : {}),
		...(body.platformFeePercent !== undefined
			? { platformFeePercent: body.platformFeePercent }
			: {}),
		refreshUrl: body.refreshUrl,
		returnUrl: body.returnUrl,
		client,
	});
	return json(result);
}

async function getVendorPayouts(
	ctx: PluginContext,
	vendorId: string,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const sync = url.searchParams.get("sync") === "1";
	if (sync) {
		const client = await loadStripeClient(ctx);
		if (!client) return json({ error: "Stripe not configured" }, 500);
		await syncPayoutsFromStripe(ctx, { vendorId, client });
	}
	const result = await storeOf<VendorPayout>(ctx, "vendor_payouts").query({
		where: { vendorId },
		orderBy: { createdAt: "desc" },
		limit: 100,
	});
	return json({
		items: result.items.map((r) => ({ ...(r.data as VendorPayout), id: r.id })),
	});
}

// ────────────────────────────────────────────────────────────────────────────
// Reports
// ────────────────────────────────────────────────────────────────────────────

// A plain `YYYY-MM-DD` parses to 00:00:00Z which, when used as an upper
// bound, excludes all orders placed *on* that day. Callers expect an
// inclusive range, so bump date-only `to` values to the end of the day.
function parseToMs(value: string | null): number {
	if (!value) return Date.parse(new Date().toISOString());
	return /^\d{4}-\d{2}-\d{2}$/.test(value)
		? Date.parse(`${value}T23:59:59.999Z`)
		: Date.parse(value);
}

async function reportRevenue(
	ctx: PluginContext,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const fromMs = Date.parse(url.searchParams.get("from") ?? "1970-01-01T00:00:00Z");
	const toMs = parseToMs(url.searchParams.get("to"));
	const groupBy = url.searchParams.get("groupBy") ?? "day";

	const result = await storeOf<Order>(ctx, "orders").query({
		where: { paymentStatus: "paid" },
		limit: 1000,
	});
	const byBucket = new Map<string, Map<string, number>>();
	for (const row of result.items) {
		const o = row.data as Order;
		const ts = Date.parse(o.createdAt);
		if (ts < fromMs || ts > toMs) continue;
		const bucket = bucketFor(o.createdAt, groupBy);
		const inner = byBucket.get(bucket) ?? new Map();
		inner.set(o.currency, (inner.get(o.currency) ?? 0) + o.paidTotal.amount);
		byBucket.set(bucket, inner);
	}
	const series = [...byBucket.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([bucket, currencies]) => ({
			bucket,
			currencies: Object.fromEntries(currencies),
		}));
	return json({ groupBy, series });
}

function bucketFor(iso: string, groupBy: string): string {
	if (groupBy === "month") return iso.slice(0, 7);
	if (groupBy === "week") {
		// ISO week bucket via Thursday anchor.
		const d = new Date(iso);
		const day = d.getUTCDay() || 7;
		d.setUTCDate(d.getUTCDate() + 4 - day);
		const year = d.getUTCFullYear();
		const weekNum = Math.ceil(
			((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7,
		);
		return `${year}-W${String(weekNum).padStart(2, "0")}`;
	}
	return iso.slice(0, 10);
}

async function reportTopProducts(
	ctx: PluginContext,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const limit = Math.min(50, Number.parseInt(url.searchParams.get("limit") ?? "10", 10));
	const fromMs = Date.parse(url.searchParams.get("from") ?? "1970-01-01T00:00:00Z");
	const toMs = parseToMs(url.searchParams.get("to"));

	// Filter orders by date first so we only sum line items from orders in
	// the requested range.
	const orderPage = await storeOf<Order>(ctx, "orders").query({ limit: 1000 });
	const inRangeOrderIds = new Set<string>();
	for (const row of orderPage.items) {
		const o = row.data as Order;
		const ts = Date.parse(o.createdAt);
		if (ts >= fromMs && ts <= toMs) inRangeOrderIds.add(row.id);
	}

	const result = await storeOf<OrderItem>(ctx, "order_items").query({ limit: 1000 });
	const counts = new Map<
		string,
		{ productId: string; name: string; units: number; revenue: number; currency: string }
	>();
	for (const row of result.items) {
		const it = row.data as OrderItem;
		if (!inRangeOrderIds.has(it.orderId)) continue;
		const key = it.productId;
		const prev = counts.get(key) ?? {
			productId: key,
			name: it.name,
			units: 0,
			revenue: 0,
			currency: it.total.currency,
		};
		prev.units += it.quantity;
		prev.revenue += it.total.amount;
		counts.set(key, prev);
	}
	const items = [...counts.values()]
		.sort((a, b) => b.revenue - a.revenue)
		.slice(0, limit);
	return json({ items });
}

async function reportTopCustomers(
	ctx: PluginContext,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const limit = Math.min(50, Number.parseInt(url.searchParams.get("limit") ?? "10", 10));
	const result = await storeOf<Customer>(ctx, "customers").query({ limit: 1000 });
	const items = result.items
		.map((r) => ({ ...(r.data as Customer), id: r.id }))
		.sort((a, b) => {
			const totalA = Object.values(a.totalSpent ?? {}).reduce((s, v) => s + v, 0);
			const totalB = Object.values(b.totalSpent ?? {}).reduce((s, v) => s + v, 0);
			return totalB - totalA;
		})
		.slice(0, limit);
	return json({ items });
}

async function reportMrr(ctx: PluginContext): Promise<Response> {
	const result = await storeOf<Subscription>(ctx, "subscriptions").query({
		where: { status: "active" },
		limit: 1000,
	});
	const mrr: Record<string, number> = {};
	for (const row of result.items) {
		const sub = row.data as Subscription;
		const months =
			sub.interval === "month"
				? sub.intervalCount
				: sub.interval === "year"
					? sub.intervalCount * 12
					: sub.interval === "week"
						? sub.intervalCount / 4.345
						: sub.intervalCount / 30;
		if (months <= 0) continue;
		const perMonth = Math.round((sub.unitAmount.amount * sub.quantity) / months);
		mrr[sub.currency] = (mrr[sub.currency] ?? 0) + perMonth;
	}
	return json({ mrr });
}

// ────────────────────────────────────────────────────────────────────────────
// Widgets
// ────────────────────────────────────────────────────────────────────────────

async function widgetRevenue(ctx: PluginContext): Promise<Response> {
	const now = Date.now();
	const sevenAgo = new Date(now - 7 * 86_400_000).toISOString();
	const thirtyAgo = new Date(now - 30 * 86_400_000).toISOString();
	const result = await storeOf<Order>(ctx, "orders").query({
		where: { paymentStatus: "paid" },
		limit: 500,
	});
	const seven: Record<string, number> = {};
	const thirty: Record<string, number> = {};
	for (const row of result.items) {
		const o = row.data as Order;
		if (o.createdAt >= thirtyAgo) {
			thirty[o.currency] = (thirty[o.currency] ?? 0) + o.paidTotal.amount;
		}
		if (o.createdAt >= sevenAgo) {
			seven[o.currency] = (seven[o.currency] ?? 0) + o.paidTotal.amount;
		}
	}
	return json({ sevenDay: seven, thirtyDay: thirty });
}

async function widgetLowStock(ctx: PluginContext): Promise<Response> {
	// Scan at most 200 products; for larger catalogues we'd need an index.
	if (!ctx.content) return json({ items: [] });
	const result = await ctx.content.list("products", { limit: 200 });
	const items = result.items
		.map((it) => {
			const data = normalizeProductFields(
				it.data as Record<string, unknown>,
			);
			return {
				productId: it.id,
				title: data.title,
				stockQuantity: data.stockQuantity,
				lowStockThreshold: data.lowStockThreshold,
				belowThresholdAt: data.belowThresholdAt,
			};
		})
		.filter((p) => p.belowThresholdAt !== null && p.belowThresholdAt !== undefined)
		.slice(0, 10);
	return json({ items });
}

async function widgetRecentOrders(ctx: PluginContext): Promise<Response> {
	const result = await storeOf<Order>(ctx, "orders").query({
		orderBy: { createdAt: "desc" },
		limit: 5,
	});
	return json({
		items: result.items.map((r) => {
			const o = r.data as Order;
			return {
				id: r.id,
				orderNumber: o.orderNumber,
				status: o.status,
				total: o.total,
				customerEmail: o.customerEmail,
				createdAt: o.createdAt,
			};
		}),
	});
}

async function widgetPendingReviews(ctx: PluginContext): Promise<Response> {
	const count = await storeOf<Review>(ctx, "reviews").count({ status: "pending" });
	return json({ count });
}

async function widgetFailedSubscriptions(ctx: PluginContext): Promise<Response> {
	const result = await storeOf<Subscription>(ctx, "subscriptions").query({
		where: { status: "past_due" },
		limit: 50,
	});
	return json({
		count: result.items.length,
		items: result.items
			.slice(0, 5)
			.map((r) => ({ ...(r.data as Subscription), id: r.id })),
	});
}

// ────────────────────────────────────────────────────────────────────────────
// Route map
// ────────────────────────────────────────────────────────────────────────────

export const adminApiRoutes = {
	// Orders
	"admin/orders": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			queryOrders(getCtx(routeCtx, _c), routeCtx.request),
	},
	"admin/orders/item": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const id = queryOrPath(routeCtx.request, "id", "orders");
			if (!id) return json({ error: "Missing order id" }, 400);
			return getOrderDetail(ctx, id);
		},
	},
	"admin/orders/refund": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const id = queryOrPath(routeCtx.request, "id", "orders");
			if (!id) return json({ error: "Missing order id" }, 400);
			return postOrderRefund(ctx, id, routeCtx);
		},
	},
	"admin/orders/status": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const id = queryOrPath(routeCtx.request, "id", "orders");
			if (!id) return json({ error: "Missing order id" }, 400);
			return postOrderStatus(ctx, id, routeCtx);
		},
	},

	// Customers
	"admin/customers": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			queryCustomers(getCtx(routeCtx, _c), routeCtx.request),
	},
	"admin/customers/item": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const id = queryOrPath(routeCtx.request, "id", "customers");
			if (!id) return json({ error: "Missing customer id" }, 400);
			return getCustomerDetail(getCtx(routeCtx, _c), id);
		},
	},

	// Coupons
	"admin/coupons": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (routeCtx.request.method === "POST") {
				const body = routeCtx.input as Partial<Coupon> & { code?: string };
				if (!body.code) return json({ error: "code required" }, 400);
				const coupon = await upsertCoupon(ctx, body as Partial<Coupon> & { code: string });
				return json({ coupon });
			}
			return listCoupons(ctx, routeCtx.request);
		},
	},
	"admin/coupons/item": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const id = queryOrPath(routeCtx.request, "id", "coupons");
			if (!id) return json({ error: "Missing coupon id" }, 400);
			if (routeCtx.request.method === "DELETE") {
				await storeOf<Coupon>(ctx, "coupons").delete(id);
				return json({ ok: true });
			}
			const body = routeCtx.input as Partial<Coupon>;
			const coupon = await upsertCoupon(
				ctx,
				{ ...body, code: body.code ?? "" } as Partial<Coupon> & { code: string },
				id,
			);
			return json({ coupon });
		},
	},

	// Shipping
	"admin/shipping": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			listShippingZones(getCtx(routeCtx, _c)),
	},
	"admin/shipping/zones": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (routeCtx.request.method === "POST")
				return postShippingZone(ctx, routeCtx);
			return listShippingZones(ctx);
		},
	},
	"admin/shipping/zones/item": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const id = queryOrPath(routeCtx.request, "id", "zones");
			if (!id) return json({ error: "Missing zone id" }, 400);
			if (routeCtx.request.method === "PATCH")
				return patchShippingZone(ctx, id, routeCtx);
			if (routeCtx.request.method === "DELETE")
				return deleteShippingZone(ctx, id);
			return json({ error: "Method not allowed" }, 405);
		},
	},
	"admin/shipping/methods": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (routeCtx.request.method === "POST")
				return postShippingMethod(ctx, routeCtx);
			return json({ error: "Method not allowed" }, 405);
		},
	},
	"admin/shipping/methods/item": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const id = queryOrPath(routeCtx.request, "id", "methods");
			if (!id) return json({ error: "Missing method id" }, 400);
			if (routeCtx.request.method === "PATCH")
				return patchShippingMethod(ctx, id, routeCtx);
			if (routeCtx.request.method === "DELETE")
				return deleteShippingMethod(ctx, id);
			return json({ error: "Method not allowed" }, 405);
		},
	},
	"admin/shipping/classes": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (routeCtx.request.method === "POST")
				return postShippingClass(ctx, routeCtx);
			return json({ error: "Method not allowed" }, 405);
		},
	},
	"admin/shipping/classes/item": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const id = queryOrPath(routeCtx.request, "id", "classes");
			if (!id) return json({ error: "Missing class id" }, 400);
			if (routeCtx.request.method === "PATCH")
				return patchShippingClass(ctx, id, routeCtx);
			if (routeCtx.request.method === "DELETE")
				return deleteShippingClass(ctx, id);
			return json({ error: "Method not allowed" }, 405);
		},
	},

	// Tax
	"admin/tax/rates": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (routeCtx.request.method === "POST") return postTaxRate(ctx, routeCtx);
			return listTaxRates(ctx);
		},
	},
	"admin/tax/rates/item": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const id = queryOrPath(routeCtx.request, "id", "rates");
			if (!id) return json({ error: "Missing rate id" }, 400);
			if (routeCtx.request.method === "PATCH") return patchTaxRate(ctx, id, routeCtx);
			if (routeCtx.request.method === "DELETE") return deleteTaxRate(ctx, id);
			return json({ error: "Method not allowed" }, 405);
		},
	},

	// Subscriptions
	"admin/subscriptions": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			listSubscriptions(getCtx(routeCtx, _c), routeCtx.request),
	},
	"admin/subscriptions/action": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const url = new URL(routeCtx.request.url);
			const input = (routeCtx.input ?? {}) as {
				id?: string;
				action?: string;
			};
			// Prefer query/body; fall back to legacy path segments.
			const parts = pathParts(routeCtx.request);
			const subIdx = parts.lastIndexOf("subscriptions");
			const id =
				url.searchParams.get("id") ??
				input.id ??
				(subIdx !== -1 ? parts[subIdx + 1] : undefined);
			const action =
				url.searchParams.get("action") ??
				input.action ??
				(subIdx !== -1 ? parts[subIdx + 2] : undefined);
			if (!id || !action) {
				return json({ error: "Missing subscription id or action" }, 400);
			}
			return postSubscriptionAction(ctx, id, action, routeCtx);
		},
	},

	// Reviews
	"admin/reviews": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			listReviews(getCtx(routeCtx, _c), routeCtx.request),
	},
	"admin/reviews/moderate": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const id = queryOrPath(routeCtx.request, "id", "reviews");
			if (!id) return json({ error: "Missing review id" }, 400);
			return postReviewModerate(getCtx(routeCtx, _c), id, routeCtx);
		},
	},

	// Vendors
	"admin/vendors": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (!(await requireConnectEnabled(ctx))) return connectOffResponse();
			return listVendors(ctx, routeCtx.request);
		},
	},
	"admin/vendors/onboard-link": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (!(await requireConnectEnabled(ctx))) return connectOffResponse();
			return postVendorOnboardLink(ctx, routeCtx);
		},
	},
	"admin/vendors/item": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (!(await requireConnectEnabled(ctx))) return connectOffResponse();
			const id = queryOrPath(routeCtx.request, "id", "vendors");
			if (!id) return json({ error: "Missing vendor id" }, 400);
			if (routeCtx.request.method === "PATCH") {
				return patchVendor(ctx, id, routeCtx);
			}
			return json({ error: "Method not allowed" }, 405);
		},
	},
	"admin/vendors/refresh": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (!(await requireConnectEnabled(ctx))) return connectOffResponse();
			const id = queryOrPath(routeCtx.request, "id", "vendors");
			if (!id) return json({ error: "Missing vendor id" }, 400);
			return refreshVendorFromStripe(ctx, id);
		},
	},
	"admin/vendors/payouts": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (!(await requireConnectEnabled(ctx))) return connectOffResponse();
			const id = queryOrPath(routeCtx.request, "id", "vendors");
			if (!id) return json({ error: "Missing vendor id" }, 400);
			return getVendorPayouts(ctx, id, routeCtx.request);
		},
	},

	// Reports
	"admin/reports/revenue": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			reportRevenue(getCtx(routeCtx, _c), routeCtx.request),
	},
	"admin/reports/top-products": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			reportTopProducts(getCtx(routeCtx, _c), routeCtx.request),
	},
	"admin/reports/top-customers": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			reportTopCustomers(getCtx(routeCtx, _c), routeCtx.request),
	},
	"admin/reports/mrr": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			reportMrr(getCtx(routeCtx, _c)),
	},

	// Widgets
	"admin/widgets/revenue-snapshot": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			widgetRevenue(getCtx(routeCtx, _c)),
	},
	"admin/widgets/low-stock-alerts": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			widgetLowStock(getCtx(routeCtx, _c)),
	},
	"admin/widgets/recent-orders": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			widgetRecentOrders(getCtx(routeCtx, _c)),
	},
	"admin/widgets/pending-reviews": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			widgetPendingReviews(getCtx(routeCtx, _c)),
	},
	"admin/widgets/failed-subscriptions": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) =>
			widgetFailedSubscriptions(getCtx(routeCtx, _c)),
	},

	// Settings
	"admin/settings": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			if (routeCtx.request.method === "POST") {
				const body = (routeCtx.input ?? {}) as Record<string, unknown>;
				// Drop masked-secret noops up front so validation sees only
				// real writes.
				for (const k of Object.keys(body)) {
					if (
						SECRET_SETTINGS_KEYS.has(k) &&
						typeof body[k] === "string" &&
						(body[k] as string).startsWith(MASKED_SECRET_PREFIX)
					) {
						delete body[k];
					}
				}
				const currentEnabled = await ctx.kv.get<string[]>(
					"settings:enabledCurrencies",
				);
				const report = validateSettings(body, {
					currentEnabledCurrencies: currentEnabled ?? undefined,
				});
				if (!report.ok) {
					return json({ error: "invalid_settings", errors: report.errors }, 400);
				}
				for (const [k, v] of Object.entries(report.values)) {
					await ctx.kv.set(`settings:${k}`, v);
				}
				return json({ ok: true });
			}
			const values: Record<string, unknown> = {};
			const secrets: Record<string, { isSet: boolean; hint: string | null }> = {};
			for (const key of SETTINGS_KEYS) {
				const v = await ctx.kv.get(`settings:${key}`);
				if (SECRET_SETTINGS_KEYS.has(key)) {
					const isSet = typeof v === "string" && v.length > 0;
					secrets[key] = {
						isSet,
						hint: isSet ? secretHint(v) : null,
					};
					values[key] = null;
				} else {
					values[key] = v ?? null;
				}
			}
			return json({ ...values, _secrets: secrets });
		},
	},

	// Stripe health check — used by the Settings page "Test connection" button.
	"admin/stripe/ping": {
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = getCtx(routeCtx, _c);
			const client = await loadStripeClient(ctx);
			if (!client) {
				return json({ ok: false, error: "Stripe secret key not set" }, 400);
			}
			try {
				const account = await stripeCall<{
					id: string;
					charges_enabled?: boolean;
					payouts_enabled?: boolean;
				}>(ctx, { method: "GET", path: "/account", client });
				return json({
					ok: true,
					accountId: account.id,
					chargesEnabled: !!account.charges_enabled,
					payoutsEnabled: !!account.payouts_enabled,
				});
			} catch (err) {
				return json(
					{ ok: false, error: err instanceof Error ? err.message : "Ping failed" },
					502,
				);
			}
		},
	},

	// Single-key settings validator — used by the settings form for
	// real-time inline error feedback without hitting the full save path.
	"admin/settings/validate": {
		handler: async (routeCtx: RouteContext) => {
			const body = (routeCtx.input ?? {}) as { key?: string; value?: unknown };
			if (!body.key) return json({ ok: false, error: "key required" }, 400);
			const result = validateSettingsKey(body.key, body.value);
			if (result.ok) return json({ ok: true, value: result.value });
			return json({ ok: false, error: result.error });
		},
	},
};

// Re-exports for other modules that need the canonical lists.
export { SETTINGS_KEYS, SECRET_SETTINGS_KEYS, normalizeCurrencyList };

// Re-exports so phase 16 reports + dashboard widgets can reuse helpers.
export { add, money, sub, zero };
export type { Money };

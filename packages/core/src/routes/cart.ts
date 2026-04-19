/**
 * Cart routes — all public.
 *
 *   GET    /cart                         — current cart (creates if missing)
 *   POST   /cart/items                   — add line item { productId, variantId?, quantity }
 *   PATCH  /cart/item?lineId={id}        — update qty
 *   DELETE /cart/item?lineId={id}        — remove
 *   POST   /cart/coupon                  — apply { code }
 *   DELETE /cart/coupon/remove?code={code} — remove
 *   POST   /cart/shipping-location       — minimal ship-to {country, postalCode} (hosted checkout)
 *   POST   /cart/shipping-address        — full address → recalc tax (embedded checkout)
 *   POST   /cart/shipping-methods        — list available rates for current ship-to
 *   POST   /cart/shipping-method         — set method id
 *   POST   /cart/currency                — switch (only if cart empty)
 *   GET    /cart/restore?token={token}   — abandoned-cart recovery link
 *
 * Ids ride as query strings because emdash's plugin route registry
 * is exact-match — it has no `:param` matcher. See `cart/item` for the
 * path-fallback we leave for stale links.
 *
 * The session id is read from the request cookies (`dashcommerce_sid`) and
 * created lazily in `resolveSessionId`. Runtime (`sandbox-entry.ts`)
 * registers these under `/_emdash/api/plugins/dashcommerce/cart*`.
 *
 * Any handler that calls `getOrCreate` must attach `setCookie` from
 * `resolveSessionId` on the response when present; otherwise the first
 * write (e.g. add-to-cart) is stored under a session id the browser
 * never receives, and the next GET uses a new empty cart.
 */

import type { PluginContext, RouteContext } from "emdash";
import { randomId } from "../util/ids";
import { getCart, getOrCreate, save, switchCurrency } from "../cart/store";
import { recalculate, type PricingPolicy } from "../cart/calculate";
import { verifyRestoreToken } from "../abandoned-cart/recover";
import { resolveDiscount, validateCoupon } from "../coupons/validate";
import { calculateRates } from "../shipping/calculate";
import { pickZone } from "../shipping/calculate";
import type {
	CartLineItem,
	CartState,
	Coupon,
	CurrencyCode,
	ShippingMethod,
	ShippingZone,
} from "../types";
import { resolvePrice } from "../products/pricing";
import { normalizeProductFields } from "../products/normalize";

// Cart routes must return HTTP 4xx on failure — returning a plain
// `{ error }` object gets serialized as `{ status: 200, body: { error } }`
// by emdash's adapter, and storefront `fetch()` treats that as success.
// The storefront then either shows stale state or dispatches
// cart-updated events with no actual mutation. Always hand back a
// proper `Response` for both the error and success paths so the wire
// shape is predictable.
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
}

/** Attach Set-Cookie when `resolveSessionId` minted a new id (no cookie on the request). */
function withSessionCookie(
	setCookie: string | undefined,
	init: ResponseInit = {},
): ResponseInit {
	if (!setCookie) return init;
	return {
		...init,
		headers: {
			...(init.headers as Record<string, string> | undefined),
			"Set-Cookie": setCookie,
		},
	};
}

function errorResponse(message: string, status = 400, setCookie?: string): Response {
	return jsonResponse({ error: message }, withSessionCookie(setCookie, { status }));
}

const SID_COOKIE = "dashcommerce_sid";

// randomId moved to util/ids.ts; see import above.

export function resolveSessionId(req: Request): { sessionId: string; setCookie?: string } {
	const cookie = req.headers.get("cookie") ?? "";
	const match = cookie.match(new RegExp(`(?:^|; )${SID_COOKIE}=([^;]+)`));
	if (match && match[1]) return { sessionId: decodeURIComponent(match[1]) };
	const sessionId = randomId();
	return {
		sessionId,
		setCookie: `${SID_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
	};
}

async function readPricingPolicy(ctx: PluginContext): Promise<PricingPolicy> {
	const mode = (await ctx.kv.get<string>("settings:taxMode")) ?? "flat";
	const pct = (await ctx.kv.get<number>("settings:flatTaxRatePercent")) ?? 0;
	const onShipping = (await ctx.kv.get<boolean>("settings:taxAppliesToShipping")) ?? false;
	const policy: PricingPolicy = {
		taxMode: mode === "table" ? "table" : mode === "stripe_tax" ? "stripe_tax" : "flat",
		taxAppliesToShipping: onShipping,
	};
	if (mode === "flat" || mode !== "table") {
		policy.flatTaxPercent = pct;
	}
	return policy;
}

async function defaultCurrency(ctx: PluginContext): Promise<CurrencyCode> {
	return (await ctx.kv.get<CurrencyCode>("settings:defaultCurrency")) ?? "USD";
}

/**
 * Load a product from the host content collection by ULID or slug.
 *
 * emdash stores the ULID as the DB primary key; `ctx.content.get`
 * expects that ULID. Callers (storefront forms, islands) may pass
 * either the ULID (preferred, from `entry.data.id`) or the slug
 * (from `entry.id` in live-collection mode). We try ULID first, fall
 * back to a slug-scoped list scan.
 *
 * Returns `null` when nothing matches or the entry isn't published.
 */
async function loadProduct(ctx: PluginContext, idOrSlug: string) {
	const content = ctx.content;
	if (!content) return null;
	// Fast path: try as ULID.
	let record = await content.get("products", idOrSlug);
	if (!record) {
		// Slug fallback: list() is the only way to query by slug from
		// the plugin content API today. Scanning 200 is enough — large
		// catalogues should be passing the ULID (the UI already has it
		// from the entry envelope).
		const list = await content.list("products", { limit: 200 });
		const hit = list.items.find(
			(r) => r.slug === idOrSlug || r.id === idOrSlug,
		);
		record = hit ?? null;
	}
	if (!record || record.status !== "published") return null;
	return record;
}

export const cartRoutes = {
	cart: {
		public: true,
		handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			// Re-run recalculate so policy changes made after the cart was
			// last mutated (tax rate, shipping cost, etc.) show up on reads.
			// Pure and cheap — no product re-pricing here.
			const policy = await readPricingPolicy(ctx);
			const repriced = recalculate(cart, policy);
			// Only persist if the totals actually changed, to avoid bumping
			// `updatedAt` on every GET and thrashing the abandoned-cart cron.
			const changed =
				repriced.taxTotal.amount !== cart.taxTotal.amount ||
				repriced.total.amount !== cart.total.amount ||
				repriced.subtotal.amount !== cart.subtotal.amount ||
				repriced.shippingTotal.amount !== cart.shippingTotal.amount;
			const out = changed ? await save(ctx, repriced) : cart;
			return jsonResponse({ cart: out }, withSessionCookie(setCookie));
		},
	},

	"cart/items": {
		public: true,
		handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
			const body = routeCtx.input as {
				productId?: string;
				variantId?: string;
				quantity?: number;
			};
			if (!body.productId) return errorResponse("productId required", 400);
			const qty = Math.max(1, Math.floor(body.quantity ?? 1));

			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));

			const product = await loadProduct(ctx, body.productId);
			if (!product) {
				return errorResponse("Product not found or unavailable", 404, setCookie);
			}

			// emdash stores commerce fields under their snake_case slugs.
			// Normalize into our camelCase ProductFields shape before any
			// downstream read.
			const fields = normalizeProductFields(
				product.data as Record<string, unknown>,
			);
			const priced = resolvePrice({ product: fields, currency: cart.currency });
			if (!priced) {
				const available = Object.keys(fields.prices ?? {});
				const enabled =
					(await ctx.kv.get<string[]>("settings:enabledCurrencies")) ?? [];
				const switchable = available.filter(
					(c) => enabled.length === 0 || enabled.includes(c),
				);
				const hint =
					switchable.length > 0
						? `Try switching the storefront currency to ${switchable.join(", ")}.`
						: "Ask the shop operator to price this product in your currency.";
				return jsonResponse(
					{
						error: `This product isn't priced in ${cart.currency}. ${hint}`,
						code: "currency_not_priced",
						cartCurrency: cart.currency,
						availableCurrencies: available,
						switchableCurrencies: switchable,
					},
					withSessionCookie(setCookie, { status: 409 }),
				);
			}

			// Merge with existing line if same product+variant combination
			const existing = cart.items.find(
				(i) => i.productId === body.productId && i.variantId === body.variantId,
			);
			let items: CartLineItem[];
			if (existing) {
				items = cart.items.map((i) =>
					i === existing
						? {
								...i,
								quantity: i.quantity + qty,
								lineSubtotal: {
									currency: i.unitPrice.currency,
									amount: i.unitPrice.amount * (i.quantity + qty),
								},
							}
						: i,
				);
			} else {
				const lineId = randomId();
				const newItem: CartLineItem = {
					lineId,
					productId: body.productId,
					...(body.variantId ? { variantId: body.variantId } : {}),
					quantity: qty,
					unitPrice: priced.unit,
					lineSubtotal: {
						currency: priced.unit.currency,
						amount: priced.unit.amount * qty,
					},
					title: fields.title,
					isDigital: fields.isVirtual || fields.isDownloadable,
					...(fields.vendorId ? { vendorId: fields.vendorId } : {}),
					...(fields.subscriptionConfig
						? { subscriptionConfig: fields.subscriptionConfig }
						: {}),
					...(fields.shippingClassSlug !== null
						? { shippingClassSlug: fields.shippingClassSlug }
						: {}),
					...(fields.weightGrams !== null ? { weightGrams: fields.weightGrams } : {}),
				};
				items = [...cart.items, newItem];
			}

			const updated = recalculate({ ...cart, items }, await readPricingPolicy(ctx));
			const saved = await save(ctx, updated);
			return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
		},
	},

	/**
	 * Empty the cart without destroying the session (coupons, shipping
	 * selection, and stored contact info are all dropped — anything the
	 * server-side `recalculate()` pipeline would need to re-derive from
	 * zero items is cleared). Leaves the `dashcommerce_sid` cookie in
	 * place so the browser can keep adding to the same logical cart.
	 *
	 * Accepts POST or DELETE. Returns the freshly-empty cart so the UI
	 * can sync without a follow-up GET.
	 */
	"cart/clear": {
		public: true,
		handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
			const method = routeCtx.request.method.toUpperCase();
			if (method !== "POST" && method !== "DELETE") {
				return errorResponse("Use POST or DELETE to clear the cart", 405);
			}
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			const emptied: CartState = {
				...cart,
				items: [],
				coupons: [],
				shippingMethod: undefined,
			};
			const saved = await save(
				ctx,
				recalculate(emptied, await readPricingPolicy(ctx)),
			);
			return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
		},
	},

	"cart/currency": {
		public: true,
		handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
			const body = routeCtx.input as { currency?: string };
			if (!body.currency) return errorResponse("currency required", 400);
			const code = body.currency.toUpperCase();

			// Guard against arbitrary currency codes — only accept codes the
			// operator has explicitly enabled in settings.
			const enabled = (await ctx.kv.get<string[]>("settings:enabledCurrencies")) ?? [];
			if (enabled.length > 0 && !enabled.includes(code)) {
				return errorResponse(
					`Currency ${code} is not enabled for this store`,
					400,
				);
			}

			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			try {
				const next = switchCurrency(cart, code);
				const saved = await save(ctx, next);
				return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
			} catch (err) {
				return errorResponse(
					err instanceof Error ? err.message : "Could not switch currency",
					409,
					setCookie,
				);
			}
		},
	},

	"cart/shipping-address": {
		public: true,
		handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
			const body = routeCtx.input as { address?: CartState["shippingAddress"] };
			if (!body.address) return errorResponse("address required", 400);
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			const updated = recalculate(
				{ ...cart, shippingAddress: body.address },
				await readPricingPolicy(ctx),
			);
			const saved = await save(ctx, updated);
			return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
		},
	},

	/**
	 * Stamp customer email + billing address onto the cart. For sites
	 * where shipping = billing, a single POST after the address form is
	 * enough. Also accepts an optional `shippingAddress` so callers can
	 * set both in one round trip.
	 */
	"cart/contact": {
		public: true,
		handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
			const body = routeCtx.input as {
				email?: string;
				billingAddress?: CartState["billingAddress"];
				shippingAddress?: CartState["shippingAddress"];
				notes?: string;
			};
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			const next: CartState = { ...cart };
			if (body.email) next.customerEmail = body.email;
			if (body.billingAddress) next.billingAddress = body.billingAddress;
			if (body.shippingAddress) next.shippingAddress = body.shippingAddress;
			if (body.notes !== undefined) next.notes = body.notes;
			const updated = recalculate(next, await readPricingPolicy(ctx));
			const saved = await save(ctx, updated);
			return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
		},
	},

	/**
	 * Update quantity on an existing cart line (PATCH) or remove the
	 * line entirely (DELETE). Quantity <= 0 on PATCH also removes.
	 *
	 * Wire shape: `cart/item?lineId={id}` — emdash's plugin route
	 * registry does an exact key match and has no `:param` matcher,
	 * so ids ride as query-string. The route is keyed `cart/item`
	 * (singular) to sit next to the collection endpoint `cart/items`
	 * (plural, the POST add-to-cart handler). We still parse a
	 * trailing path segment as a last-resort fallback so legacy links
	 * don't die.
	 */
	"cart/item": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const url = new URL(routeCtx.request.url);
			const qsLineId = url.searchParams.get("lineId");
			const parts = url.pathname.split("/").filter(Boolean);
			const itemsIdx = parts.lastIndexOf("items");
			const itemIdx = parts.lastIndexOf("item");
			const pathLineId =
				itemIdx !== -1
					? parts[itemIdx + 1]
					: itemsIdx !== -1
						? parts[itemsIdx + 1]
						: undefined;
			const lineId = qsLineId ?? pathLineId;
			if (!lineId) return errorResponse("lineId required", 400);

			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));

			const method = routeCtx.request.method.toUpperCase();
			let items: CartLineItem[];
			if (method === "DELETE") {
				items = cart.items.filter((i) => i.lineId !== lineId);
			} else {
				const body = routeCtx.input as { quantity?: number };
				const qty = Math.max(0, Math.floor(body.quantity ?? 0));
				if (qty === 0) {
					items = cart.items.filter((i) => i.lineId !== lineId);
				} else {
					items = cart.items.map((i) =>
						i.lineId === lineId
							? {
									...i,
									quantity: qty,
									lineSubtotal: {
										currency: i.unitPrice.currency,
										amount: i.unitPrice.amount * qty,
									},
								}
							: i,
					);
				}
			}

			if (!cart.items.some((i) => i.lineId === lineId)) {
				return errorResponse("Cart line not found", 404, setCookie);
			}

			const updated = recalculate({ ...cart, items }, await readPricingPolicy(ctx));
			const saved = await save(ctx, updated);
			return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
		},
	},

	/**
	 * Apply a coupon code. Rejects if the code doesn't exist, is
	 * expired, violates the cart's min/max constraints, or — for
	 * fixed-currency coupons — doesn't match the cart currency.
	 */
	"cart/coupon": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const body = routeCtx.input as { code?: string };
			if (!body.code) return errorResponse("code required", 400);
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));

			const couponsStore = (
				ctx.storage as unknown as {
					coupons: { query(opts: { where: Record<string, string>; limit: number }): Promise<{ items: Array<{ id: string; data: Coupon }> }> };
				}
			).coupons;
			const result = await couponsStore.query({
				where: { code: body.code.toUpperCase() },
				limit: 1,
			});
			const row = result.items[0];
			if (!row) return errorResponse("Coupon not found", 404, setCookie);
			const coupon: Coupon = { ...row.data, id: row.id };

			const validation = validateCoupon(coupon, { cart });
			if (!validation.ok) {
				return errorResponse(validation.reason, 409, setCookie);
			}

			try {
				const applied = resolveDiscount(coupon, cart);
				const nextCart: CartState = {
					...cart,
					coupons: [
						...cart.coupons.filter((c) => c.code !== applied.code),
						applied,
					],
				};
				const updated = recalculate(nextCart, await readPricingPolicy(ctx));
				const saved = await save(ctx, updated);
				return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
			} catch (err) {
				return errorResponse(
					err instanceof Error ? err.message : "Could not apply coupon",
					409,
					setCookie,
				);
			}
		},
	},

	/**
	 * DELETE /cart/coupon?code={CODE}  — remove an applied coupon.
	 *
	 * The id rides as a query param because emdash's plugin route
	 * registry is exact-match. See `cart/items` above.
	 */
	"cart/coupon/remove": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const url = new URL(routeCtx.request.url);
			const qsCode = url.searchParams.get("code");
			const parts = url.pathname.split("/").filter(Boolean);
			const idx = parts.lastIndexOf("coupon");
			const pathCode = idx !== -1 ? parts[idx + 1] : undefined;
			const code = qsCode ?? pathCode;
			if (!code) return errorResponse("code required", 400);
			if (routeCtx.request.method.toUpperCase() !== "DELETE") {
				return errorResponse("Use DELETE to remove a coupon", 405);
			}
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			const nextCart: CartState = {
				...cart,
				coupons: cart.coupons.filter(
					(c) => c.code.toUpperCase() !== code.toUpperCase(),
				),
			};
			const updated = recalculate(nextCart, await readPricingPolicy(ctx));
			const saved = await save(ctx, updated);
			return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
		},
	},

	/**
	 * Lightweight "where does this ship to?" endpoint used by the
	 * hosted-checkout pre-flight form. Accepts just `{country,
	 * postalCode}`, writes a placeholder `shippingAddress` on the cart
	 * so that zone-picking + rate calc can run before we redirect the
	 * customer to Stripe's page. The remaining address fields
	 * (name/line1/city/region) will be populated post-redirect from
	 * `checkout.session.completed`.
	 *
	 * Contrast with `cart/contact`, which requires the full address
	 * because the embedded-Elements flow has nowhere else to collect
	 * it.
	 */
	"cart/shipping-location": {
		public: true,
		handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
			const body = (routeCtx.input ?? {}) as {
				country?: string;
				postalCode?: string;
			};
			const country = body.country?.trim().toUpperCase();
			const postalCode = body.postalCode?.trim();
			if (!country || country.length !== 2) {
				return errorResponse("country (ISO-2) required", 400);
			}
			if (!postalCode) {
				return errorResponse("postalCode required", 400);
			}
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			const prior = cart.shippingAddress;
			const nextCart: CartState = {
				...cart,
				shippingAddress: {
					firstName: prior?.firstName ?? "",
					lastName: prior?.lastName ?? "",
					line1: prior?.line1 ?? "",
					...(prior?.line2 ? { line2: prior.line2 } : {}),
					city: prior?.city ?? "",
					region: prior?.region ?? "",
					postalCode,
					country,
				},
				// Clear any stale chosen method — rates need recomputing
				// for the new location.
				shippingMethod: undefined,
			};
			const updated = recalculate(nextCart, await readPricingPolicy(ctx));
			const saved = await save(ctx, updated);
			return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
		},
	},

	/**
	 * Read the shipping rate options for the current cart's shipping
	 * address. Matches the address against configured zones (first
	 * match wins by `order`), then calls `calculateRates` with the
	 * zone's methods.
	 */
	"cart/shipping-methods": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			if (!cart.shippingAddress) {
				return jsonResponse({ options: [] }, withSessionCookie(setCookie));
			}
			const zonesStore = (
				ctx.storage as unknown as {
					shipping_zones: {
						query(opts: {
							limit: number;
						}): Promise<{ items: Array<{ id: string; data: ShippingZone }> }>;
					};
				}
			).shipping_zones;
			const methodsStore = (
				ctx.storage as unknown as {
					shipping_methods: {
						query(opts: {
							where: Record<string, string | number>;
							limit: number;
						}): Promise<{ items: Array<{ id: string; data: ShippingMethod }> }>;
					};
				}
			).shipping_methods;

			const zones = (await zonesStore.query({ limit: 200 })).items.map((r) => ({
				...r.data,
				id: r.id,
			}));
			const zone = pickZone(cart.shippingAddress, zones);
			if (!zone) return jsonResponse({ options: [] }, withSessionCookie(setCookie));
			const methods = (
				await methodsStore.query({
					where: { zoneId: zone.id, enabled: 1 },
					limit: 50,
				})
			).items.map((r) => ({ ...r.data, id: r.id }));

			const options = calculateRates({
				items: cart.items,
				currency: cart.currency,
				methods,
				couponsGiveFreeShipping: cart.coupons.some((c) => c.freeShipping),
			});
			return jsonResponse({ options }, withSessionCookie(setCookie));
		},
	},

	/**
	 * Pick a shipping method. Body: { methodId }.
	 */
	"cart/shipping-method": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const body = routeCtx.input as { methodId?: string };
			if (!body.methodId) return errorResponse("methodId required", 400);
			const { sessionId, setCookie } = resolveSessionId(routeCtx.request);
			const cart = await getOrCreate(ctx, sessionId, await defaultCurrency(ctx));
			if (!cart.shippingAddress) {
				return errorResponse("Set a shipping address first", 409, setCookie);
			}
			const zonesStore = (
				ctx.storage as unknown as {
					shipping_zones: {
						query(opts: {
							limit: number;
						}): Promise<{ items: Array<{ id: string; data: ShippingZone }> }>;
					};
				}
			).shipping_zones;
			const methodsStore = (
				ctx.storage as unknown as {
					shipping_methods: {
						get(id: string): Promise<ShippingMethod | null>;
						query(opts: {
							where: Record<string, string | number>;
							limit: number;
						}): Promise<{ items: Array<{ id: string; data: ShippingMethod }> }>;
					};
				}
			).shipping_methods;
			const zones = (await zonesStore.query({ limit: 200 })).items.map((r) => ({
				...r.data,
				id: r.id,
			}));
			const zone = pickZone(cart.shippingAddress, zones);
			if (!zone) {
				return errorResponse("No shipping zone matches the address", 409, setCookie);
			}
			const methods = (
				await methodsStore.query({
					where: { zoneId: zone.id, enabled: 1 },
					limit: 50,
				})
			).items.map((r) => ({ ...r.data, id: r.id }));
			const options = calculateRates({
				items: cart.items,
				currency: cart.currency,
				methods,
				couponsGiveFreeShipping: cart.coupons.some((c) => c.freeShipping),
			});
			const chosen = options.find((o) => o.methodId === body.methodId);
			if (!chosen) {
				return errorResponse("Invalid method for this cart", 409, setCookie);
			}
			const nextCart: CartState = {
				...cart,
				shippingMethod: {
					id: chosen.methodId,
					label: chosen.label,
					amount: chosen.amount,
				},
			};
			const updated = recalculate(nextCart, await readPricingPolicy(ctx));
			const saved = await save(ctx, updated);
			return jsonResponse({ cart: saved }, withSessionCookie(setCookie));
		},
	},

	/**
	 * GET /cart/restore?token={SIGNED_TOKEN} — abandoned-cart recovery
	 * link lands here, we flip the cookie to the saved session.
	 *
	 * Token rides as a query param (exact-match route registry).
	 */
	"cart/restore": {
		public: true,
		handler: async (routeCtx: RouteContext, _ctx?: PluginContext) => {
			const ctx = (_ctx ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const url = new URL(routeCtx.request.url);
			const qsToken = url.searchParams.get("token");
			const parts = url.pathname.split("/").filter(Boolean);
			const tokenIdx = parts.lastIndexOf("restore");
			const pathToken = tokenIdx !== -1 ? parts[tokenIdx + 1] : undefined;
			const token = qsToken ?? pathToken;
			if (!token) {
				return new Response(JSON.stringify({ error: "Missing token" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			const verified = await verifyRestoreToken(ctx, token);
			if (!verified.ok || !verified.sessionId) {
				return new Response(
					JSON.stringify({ error: `Invalid token: ${verified.reason}` }),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				);
			}
			const cart = await getCart(ctx, verified.sessionId);
			if (!cart) {
				return new Response(JSON.stringify({ error: "Cart no longer exists" }), {
					status: 410,
					headers: { "Content-Type": "application/json" },
				});
			}
			const cookie = `${SID_COOKIE}=${verified.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
			return new Response(JSON.stringify({ cart }), {
				status: 200,
				headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
			});
		},
	},
};

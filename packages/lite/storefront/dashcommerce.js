/**
 * DashCommerce storefront client.
 *
 * A dependency-free ES module for themes. Copy it into your theme (for
 * example `src/lib/dashcommerce.js`) or import it from
 * `@dashcommerce/lite/storefront` in this repo. It talks to the plugin's
 * public routes under `/_emdash/api/plugins/dashcommerce-lite/`, keeps the cart
 * token in localStorage, and fires a `dashcommerce:cart` event on `window`
 * with the latest cart after every change.
 *
 *   import { createClient } from "./dashcommerce.js";
 *   const shop = createClient();
 *   await shop.addItem(productId, 1);
 *   await shop.redirectToCheckout();
 *
 * Every method returns the route's `data` on success and throws a
 * `DashCommerceError` (with `code`, for example "OUT_OF_STOCK") otherwise.
 */

export const DEFAULT_BASE = "/_emdash/api/plugins/dashcommerce-lite";
export const STORAGE_KEY = "dashcommerce-cart";
export const CART_HEADER = "X-DashCommerce-Cart";
export const CART_EVENT = "dashcommerce:cart";
/** Most `checkout/session` requests one checkout() makes (see CHECKOUT_CONTINUE). */
export const MAX_CHECKOUT_REQUESTS = 6;

export class DashCommerceError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {Record<string, unknown>} [details]
	 */
	constructor(code, message, details = {}) {
		super(message);
		this.name = "DashCommerceError";
		this.code = code;
		this.details = details;
	}
}

function browserStorage() {
	try {
		if (typeof localStorage !== "undefined") return localStorage;
	} catch {
		// Storage can throw in private modes or sandboxed iframes.
	}
	const mem = new Map();
	return {
		getItem: (k) => (mem.has(k) ? mem.get(k) : null),
		setItem: (k, v) => void mem.set(k, String(v)),
		removeItem: (k) => void mem.delete(k),
	};
}

/**
 * @param {{
 *   base?: string,
 *   storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void },
 *   fetch?: typeof fetch,
 *   events?: EventTarget | null,
 *   storageKey?: string,
 * }} [options]
 */
export function createClient(options = {}) {
	const base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, "");
	const storage = options.storage ?? browserStorage();
	const key = options.storageKey ?? STORAGE_KEY;
	const doFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
	const events =
		options.events !== undefined ? options.events : typeof window !== "undefined" ? window : null;

	const getToken = () => storage.getItem(key);
	const setToken = (t) => (t ? storage.setItem(key, t) : storage.removeItem(key));

	function emit(cart) {
		if (cart && events && typeof CustomEvent !== "undefined") {
			events.dispatchEvent(new CustomEvent(CART_EVENT, { detail: cart }));
		}
		return cart;
	}

	async function call(route, { method = "POST", body, query } = {}) {
		const token = getToken();
		const qs = query ? `?${new URLSearchParams(query)}` : "";
		const res = await doFetch(`${base}/${route}${qs}`, {
			method,
			headers: {
				Accept: "application/json",
				...(method === "GET" ? {} : { "Content-Type": "application/json" }),
				...(token ? { [CART_HEADER]: token } : {}),
			},
			...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
			credentials: "same-origin",
		});
		let json;
		try {
			json = await res.json();
		} catch {
			throw new DashCommerceError("BAD_RESPONSE", `Unexpected response (${res.status})`);
		}
		if (!json || json.success === false || !json.data) {
			const err = json?.error ?? {};
			throw new DashCommerceError(
				err.code ?? "REQUEST_FAILED",
				err.message ?? `Request failed (${res.status})`,
			);
		}
		const data = json.data;
		if (typeof data.token === "string") setToken(data.token);
		if (!data.ok) {
			const { error = {}, ...details } = data;
			if (details.cart) emit(details.cart);
			throw new DashCommerceError(
				error.code ?? "ERROR",
				error.message ?? "Request failed",
				details,
			);
		}
		return data;
	}

	return {
		getToken,
		clearToken: () => setToken(null),

		/** Current cart. A missing or expired cart comes back empty. */
		async getCart() {
			const data = await call("cart", { method: "GET" });
			if (data.token === null) setToken(null);
			return emit(data.cart);
		},

		/** Add `quantity` of a published product (its content entry id). */
		async addItem(productId, quantity = 1) {
			return emit((await call("cart/items", { body: { productId, quantity } })).cart);
		},

		/** Set a line's quantity. 0 removes the line. */
		async updateItem(lineId, quantity) {
			return emit((await call("cart/item", { body: { lineId, quantity } })).cart);
		},

		async removeItem(lineId) {
			return emit((await call("cart/item", { body: { lineId, quantity: 0 } })).cart);
		},

		async clear() {
			return emit((await call("cart/clear", {})).cart);
		},

		/**
		 * Start Stripe Checkout. Resolves to `{ url, orderId, orderKey, orderNumber }`.
		 * Throws `CART_CHANGED` (with the corrected cart in `details.cart`)
		 * when prices, shipping or tax changed since the cart was built.
		 * Repeats the request while the server answers `CHECKOUT_CONTINUE`.
		 */
		async checkout({ email } = {}) {
			// A large cart can take a few requests: the server answers
			// CHECKOUT_CONTINUE while it is still reading products, to stay
			// within its per-request limits. Send the request again.
			for (let attempt = 1; ; attempt += 1) {
				try {
					return await call("checkout/session", { body: email ? { email } : {} });
				} catch (err) {
					if (err?.code !== "CHECKOUT_CONTINUE" || attempt >= MAX_CHECKOUT_REQUESTS) throw err;
				}
			}
		},

		/** Start Checkout and send the browser to Stripe. */
		async redirectToCheckout(opts = {}) {
			const data = await this.checkout(opts);
			if (typeof location !== "undefined") location.assign(data.url);
			return data;
		},

		/** Order status for the success page. */
		async getOrder(id, orderKey) {
			return (await call("order", { method: "GET", query: { id, key: orderKey } })).order;
		},

		/**
		 * Poll the order until Stripe's webhook has confirmed payment, or
		 * until `timeoutMs`. Clears the stored cart token once paid.
		 */
		async waitForPayment(id, orderKey, { timeoutMs = 20000, intervalMs = 1500, sleep } = {}) {
			const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const order = await this.getOrder(id, orderKey);
				if (order.paymentStatus !== "pending" || Date.now() >= deadline) {
					if (order.paymentStatus === "paid") setToken(null);
					return order;
				}
				await wait(intervalMs);
			}
		},
	};
}

/** Read `order` and `key` from a success URL's query string. */
export function orderFromQuery(search = typeof location !== "undefined" ? location.search : "") {
	const q = new URLSearchParams(search);
	const id = q.get("order");
	const orderKey = q.get("key");
	return id && orderKey ? { id, orderKey } : null;
}

/** Format `{ currency, amount }` (minor units) for display. */
export function formatMoney(value, locale) {
	const fmt = new Intl.NumberFormat(locale, { style: "currency", currency: value.currency });
	const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
	return fmt.format(value.amount / 10 ** digits);
}

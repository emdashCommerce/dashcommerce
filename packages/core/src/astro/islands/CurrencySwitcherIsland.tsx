import { useEffect, useState } from "react";

export interface CurrencySwitcherIslandProps {
	/**
	 * Optional override. When omitted (the common case) the island fetches
	 * the list from `/config-check` and the active cart currency from
	 * `/cart` on mount.
	 */
	currencies?: string[];
	current?: string;
	/** Shown as the ARIA label. Defaults to "Currency". */
	label?: string;
	/**
	 * `auto-reload` (default) refreshes the page on a successful switch so
	 * server-rendered prices reflect the new currency.
	 * `event-only` skips the reload and just broadcasts
	 * `dashcommerce:cart-updated` + `dashcommerce:currency-changed`.
	 */
	afterChange?: "auto-reload" | "event-only";
}

interface ConfigCheck {
	defaultCurrency: string | null;
	enabledCurrencies?: string[];
}

interface CartResponse {
	cart?: { currency?: string; items?: unknown[] };
}

export default function CurrencySwitcherIsland({
	currencies: initialCurrencies,
	current: initialCurrent,
	label = "Currency",
	afterChange = "auto-reload",
}: CurrencySwitcherIslandProps) {
	const [currencies, setCurrencies] = useState<string[]>(
		initialCurrencies ?? [],
	);
	const [current, setCurrent] = useState<string>(initialCurrent ?? "");
	const [cartHasItems, setCartHasItems] = useState<boolean>(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		let alive = true;
		async function boot(): Promise<void> {
			try {
				const cfgPromise = initialCurrencies
					? null
					: fetch("/_emdash/api/plugins/dashcommerce/config-check", {
							credentials: "include",
						});
				const cartPromise = fetch(
					"/_emdash/api/plugins/dashcommerce/cart",
					{ credentials: "include" },
				);
				const cfgRes = cfgPromise ? await cfgPromise : null;
				const cartRes = await cartPromise;
				if (!alive) return;

				if (cfgRes) {
					const cfg = (await cfgRes.json().catch(() => ({}))) as ConfigCheck;
					const list =
						Array.isArray(cfg.enabledCurrencies) && cfg.enabledCurrencies.length > 0
							? cfg.enabledCurrencies
							: cfg.defaultCurrency
								? [cfg.defaultCurrency]
								: ["USD"];
					setCurrencies(list);
					if (!initialCurrent && cfg.defaultCurrency) {
						const fallback = cfg.defaultCurrency;
						setCurrent((prev) => prev || fallback);
					}
				}

				const cart = (await cartRes.json().catch(() => ({}))) as CartResponse;
				if (cart.cart?.currency) setCurrent(cart.cart.currency);
				setCartHasItems(
					Array.isArray(cart.cart?.items) && cart.cart.items.length > 0,
				);
			} catch (err) {
				if (!alive) return;
				setError(err instanceof Error ? err.message : "Could not load currencies");
			}
		}
		boot();
		return () => {
			alive = false;
		};
	}, [initialCurrencies, initialCurrent]);

	useEffect(() => {
		function refresh(): void {
			fetch("/_emdash/api/plugins/dashcommerce/cart", { credentials: "include" })
				.then((r) => r.json())
				.then((body: CartResponse) => {
					if (body.cart?.currency) setCurrent(body.cart.currency);
					setCartHasItems(
						Array.isArray(body.cart?.items) && body.cart.items.length > 0,
					);
				})
				.catch(() => {});
		}
		window.addEventListener("dashcommerce:cart-updated", refresh);
		return () =>
			window.removeEventListener("dashcommerce:cart-updated", refresh);
	}, []);

	async function change(next: string): Promise<void> {
		if (next === current) return;
		setError(null);
		setPending(true);
		try {
			const res = await fetch(
				"/_emdash/api/plugins/dashcommerce/cart/currency",
				{
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ currency: next }),
				},
			);
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setError(body.error ?? "Could not switch currency");
				setPending(false);
				return;
			}
			setCurrent(next);
			window.dispatchEvent(new CustomEvent("dashcommerce:cart-updated"));
			window.dispatchEvent(
				new CustomEvent("dashcommerce:currency-changed", { detail: { currency: next } }),
			);
			if (afterChange === "auto-reload") {
				window.location.reload();
			} else {
				setPending(false);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
			setPending(false);
		}
	}

	if (currencies.length < 2) {
		return null;
	}

	const title = cartHasItems
		? "Empty your cart to switch currency"
		: "Change display currency";

	return (
		<label className="dc-currency-switcher" title={title}>
			<span className="dc-currency-switcher__label">{label}</span>
			<select
				value={current}
				onChange={(e) => change(e.currentTarget.value)}
				disabled={pending || cartHasItems}
				aria-label={label}
			>
				{currencies.map((c) => (
					<option key={c} value={c}>
						{c}
					</option>
				))}
			</select>
			{error && (
				<span role="alert" className="dc-currency-switcher__error">
					{error}
				</span>
			)}
		</label>
	);
}

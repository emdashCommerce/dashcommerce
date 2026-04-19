import { useMemo, useState } from "react";

export interface VariantOption {
	id: string;
	sku: string;
	attributes: Record<string, string>;
	stockQuantity: number | null;
	priceMinor: number | null;
	currency: string;
}

export interface AddToCartIslandProps {
	productId: string;
	variantId?: string;
	variants?: VariantOption[];
	attributeKeys?: string[];
	label?: string;
	disabled?: boolean;
}

interface CurrencyMismatch {
	code: "currency_not_priced";
	cartCurrency: string;
	switchableCurrencies: string[];
}

export default function AddToCartIsland({
	productId,
	variantId,
	variants = [],
	attributeKeys = [],
	label = "Add to cart",
	disabled = false,
}: AddToCartIslandProps) {
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [mismatch, setMismatch] = useState<CurrencyMismatch | null>(null);
	const [selected, setSelected] = useState<Record<string, string>>({});
	const [quantity, setQuantity] = useState(1);

	async function switchCurrencyAndRetry(next: string) {
		setError(null);
		const res = await fetch(
			"/_emdash/api/plugins/dashcommerce/cart/currency",
			{
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ currency: next }),
			},
		);
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? `Could not switch currency to ${next}`);
			return;
		}
		setMismatch(null);
		window.dispatchEvent(
			new CustomEvent("dashcommerce:currency-changed", { detail: { currency: next } }),
		);
		await add();
	}

	const matchedVariant = useMemo(() => {
		if (variantId) return variants.find((v) => v.id === variantId) ?? null;
		if (variants.length === 0) return null;
		return (
			variants.find((v) =>
				attributeKeys.every((k) => v.attributes[k] === selected[k]),
			) ?? null
		);
	}, [variants, attributeKeys, selected, variantId]);

	const needsVariantPick =
		variants.length > 0 && !variantId && !matchedVariant && attributeKeys.length > 0;

	async function add() {
		if (!productId) {
			setError("Missing product id. Check the page that renders this component.");
			return;
		}
		setError(null);
		setMismatch(null);
		setAdding(true);
		try {
			const res = await fetch(
				"/_emdash/api/plugins/dashcommerce/cart/items",
				{
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						productId,
						...(matchedVariant
							? { variantId: matchedVariant.id }
							: variantId
								? { variantId }
								: {}),
						quantity,
					}),
				},
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
					code?: string;
					cartCurrency?: string;
					switchableCurrencies?: string[];
				};
				if (
					body.code === "currency_not_priced" &&
					body.cartCurrency &&
					Array.isArray(body.switchableCurrencies) &&
					body.switchableCurrencies.length > 0
				) {
					setMismatch({
						code: "currency_not_priced",
						cartCurrency: body.cartCurrency,
						switchableCurrencies: body.switchableCurrencies,
					});
					setError(body.error ?? "Product not priced in your currency.");
					return;
				}
				setError(body.error ?? `Could not add to cart (${res.status})`);
				return;
			}
			window.dispatchEvent(new CustomEvent("dashcommerce:cart-updated"));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setAdding(false);
		}
	}

	return (
		<div className="dc-add-to-cart">
			{attributeKeys.length > 0 && (
				<div className="dc-variant-picker">
					{attributeKeys.map((key) => {
						const values = Array.from(
							new Set(variants.map((v) => v.attributes[key]).filter(Boolean)),
						) as string[];
						return (
							<label key={key}>
								<span>{key}: </span>
								<select
									value={selected[key] ?? ""}
									onChange={(e) =>
										setSelected({ ...selected, [key]: e.currentTarget.value })
									}
								>
									<option value="">Pick {key}</option>
									{values.map((v) => (
										<option key={v} value={v}>
											{v}
										</option>
									))}
								</select>
							</label>
						);
					})}
				</div>
			)}
			<div className="dc-qty-row">
				<label>
					Qty{" "}
					<input
						type="number"
						min={1}
						value={quantity}
						onChange={(e) => setQuantity(Math.max(1, Number(e.currentTarget.value) || 1))}
					/>
				</label>
				<button
					type="button"
					disabled={disabled || adding || needsVariantPick}
					onClick={add}
				>
					{adding ? "Adding…" : needsVariantPick ? "Pick a variant" : label}
				</button>
			</div>
			{error && <p role="alert" className="dc-add-to-cart__error">{error}</p>}
			{mismatch && (
				<div className="dc-currency-mismatch" role="group" aria-label="Switch currency">
					{mismatch.switchableCurrencies.map((c) => (
						<button
							key={c}
							type="button"
							className="dc-currency-mismatch__btn"
							onClick={() => switchCurrencyAndRetry(c)}
						>
							Switch to {c} &amp; add
						</button>
					))}
				</div>
			)}
			<style>{`
				.dc-add-to-cart__error { color: var(--ember, #a00); margin: 0.5rem 0 0; font-size: 0.9em; }
				.dc-currency-mismatch {
					display: flex; flex-wrap: wrap; gap: 0.5rem;
					margin-top: 0.5rem;
				}
				.dc-currency-mismatch__btn {
					padding: 0.45rem 0.9rem;
					background: transparent;
					color: var(--accent, var(--gold, #111));
					border: 1px solid var(--accent, var(--gold, #111));
					border-radius: var(--radius, 4px);
					font-size: 0.85em;
					cursor: pointer;
					transition: background .15s, color .15s;
				}
				.dc-currency-mismatch__btn:hover {
					background: var(--accent, var(--gold, #111));
					color: var(--accent-on, #fff);
				}
			`}</style>
		</div>
	);
}

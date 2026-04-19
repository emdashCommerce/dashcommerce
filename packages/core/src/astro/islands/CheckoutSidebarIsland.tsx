/**
 * Order summary sidebar for the checkout page. Polls the cart + the
 * available shipping methods (once an address is on the cart), lets
 * the user pick a method, and renders running totals.
 *
 * Listens for `dashcommerce:cart-updated` and refetches on every
 * update so the totals stay in sync with payment-form state changes
 * the host page may trigger.
 */

import { useCallback, useEffect, useState } from "react";

interface Money {
	currency: string;
	amount: number;
}
interface CartLine {
	lineId: string;
	title: string;
	quantity: number;
	unitPrice: Money;
	lineSubtotal: Money;
}
interface ShippingMethod {
	id: string;
	label: string;
	amount: Money;
}
interface CartState {
	items: CartLine[];
	subtotal: Money;
	discountTotal: Money;
	shippingTotal: Money;
	taxTotal: Money;
	total: Money;
	currency: string;
	shippingAddress?: unknown;
	shippingMethod?: { id: string; label: string; amount: Money };
}

const API = "/_emdash/api/plugins/dashcommerce";

function formatMoney(m: Money | null | undefined, locale = "en-US") {
	if (!m) return "—";
	try {
		return new Intl.NumberFormat(locale, {
			style: "currency",
			currency: m.currency,
		}).format(m.amount / 100);
	} catch {
		return `${m.currency} ${m.amount / 100}`;
	}
}

export interface CheckoutSidebarIslandProps {
	locale?: string;
}

export default function CheckoutSidebarIsland({
	locale = "en-US",
}: CheckoutSidebarIslandProps) {
	const [cart, setCart] = useState<CartState | null>(null);
	const [methods, setMethods] = useState<ShippingMethod[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const reload = useCallback(async () => {
		try {
			const res = await fetch(`${API}/cart`, { credentials: "include" });
			if (!res.ok) {
				setError(`Failed to load cart (${res.status})`);
				return;
			}
			const body = (await res.json()) as { cart: CartState };
			setCart(body.cart);
			setError(null);
			if (body.cart.shippingAddress) {
				const mRes = await fetch(`${API}/cart/shipping-methods`, {
					credentials: "include",
				});
				if (mRes.ok) {
					const mBody = (await mRes.json()) as { options: ShippingMethod[] };
					setMethods(mBody.options);
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		}
	}, []);

	useEffect(() => {
		reload();
		const onUpdate = () => reload();
		window.addEventListener("dashcommerce:cart-updated", onUpdate);
		return () => window.removeEventListener("dashcommerce:cart-updated", onUpdate);
	}, [reload]);

	async function pickMethod(methodId: string) {
		setPending(true);
		setError(null);
		try {
			const res = await fetch(`${API}/cart/shipping-method`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ methodId }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? `Could not set shipping (${res.status})`);
				return;
			}
			const body = (await res.json()) as { cart: CartState };
			setCart(body.cart);
			window.dispatchEvent(new CustomEvent("dashcommerce:cart-updated"));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setPending(false);
		}
	}

	if (!cart) {
		return (
			<aside
				className="dc-checkout-sidebar"
				aria-label="Order summary"
				style={{
					color: "var(--text-muted, #666)",
					fontSize: "0.9em",
				}}
			>
				Loading summary…
			</aside>
		);
	}

	return (
		<aside className="dc-checkout-sidebar" aria-label="Order summary">
			<h3>Order summary</h3>
			{error && <p role="alert" className="dc-sidebar-error">{error}</p>}
			<ul className="dc-sidebar-items">
				{cart.items.map((it) => (
					<li key={it.lineId}>
						<span className="dc-sidebar-qty">{it.quantity}×</span>{" "}
						<span className="dc-sidebar-title">{it.title}</span>
						<span className="dc-sidebar-total">
							{formatMoney(it.lineSubtotal, locale)}
						</span>
					</li>
				))}
			</ul>

			{Boolean(cart.shippingAddress) && methods.length > 0 && (
				<section className="dc-sidebar-shipping">
					<h4>Shipping</h4>
					<ul>
						{methods.map((m) => (
							<li key={m.id}>
								<label>
									<input
										type="radio"
										name="shipping-method"
										checked={cart.shippingMethod?.id === m.id}
										onChange={() => pickMethod(m.id)}
										disabled={pending}
									/>{" "}
									<span>{m.label}</span>
									<span className="dc-sidebar-method-amt">
										{formatMoney(m.amount, locale)}
									</span>
								</label>
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="dc-sidebar-totals">
				<div className="dc-row">
					<span>Subtotal</span>
					<span>{formatMoney(cart.subtotal, locale)}</span>
				</div>
				{cart.discountTotal.amount > 0 && (
					<div className="dc-row">
						<span>Discount</span>
						<span>−{formatMoney(cart.discountTotal, locale)}</span>
					</div>
				)}
				{cart.shippingTotal.amount > 0 && (
					<div className="dc-row">
						<span>Shipping</span>
						<span>{formatMoney(cart.shippingTotal, locale)}</span>
					</div>
				)}
				{cart.taxTotal.amount > 0 && (
					<div className="dc-row">
						<span>Tax</span>
						<span>{formatMoney(cart.taxTotal, locale)}</span>
					</div>
				)}
				<div className="dc-row dc-row-grand">
					<strong>Total</strong>
					<strong>{formatMoney(cart.total, locale)}</strong>
				</div>
			</section>

			<style>{`
				.dc-checkout-sidebar {
					padding: 1.25rem;
					border: 1px solid var(--border-mid, #e4e4e7);
					border-radius: var(--radius-lg, 8px);
					background: var(--bg-2, #fafafa);
					color: var(--text, #111);
					position: sticky;
					top: 1rem;
				}
				.dc-checkout-sidebar h3 { margin: 0 0 0.75rem; font-size: 1em; color: var(--text, #111); }
				.dc-checkout-sidebar h4 { margin: 0.75rem 0 0.5rem; font-size: 0.9em; color: var(--text, #111); }
				.dc-sidebar-error { color: var(--ember, #a00); font-size: 0.9em; margin: 0 0 0.5rem; }
				.dc-sidebar-items { list-style: none; padding: 0; margin: 0 0 1rem; font-size: 0.9em; }
				.dc-sidebar-items li { display: grid; grid-template-columns: auto 1fr auto; gap: 0.5rem; padding: 0.25rem 0; color: var(--text, #111); }
				.dc-sidebar-qty { color: var(--text-muted, #666); }
				.dc-sidebar-title { color: var(--text, #111); }
				.dc-sidebar-total { color: var(--text, #111); font-variant-numeric: tabular-nums; }
				.dc-sidebar-shipping ul { list-style: none; padding: 0; margin: 0; font-size: 0.9em; }
				.dc-sidebar-shipping li { padding: 0.25rem 0; }
				.dc-sidebar-shipping label { display: grid; grid-template-columns: auto 1fr auto; gap: 0.5rem; align-items: center; cursor: pointer; color: var(--text, #111); }
				.dc-sidebar-method-amt { font-variant-numeric: tabular-nums; color: var(--text-mid, #444); }
				.dc-sidebar-totals { margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--border-mid, #e4e4e7); }
				.dc-row { display: flex; justify-content: space-between; padding: 0.25rem 0; font-size: 0.9em; color: var(--text, #111); }
				.dc-row-grand { padding-top: 0.5rem; margin-top: 0.5rem; border-top: 1px solid var(--border-mid, #e4e4e7); font-size: 1em; color: var(--text, #111); }
			`}</style>
		</aside>
	);
}

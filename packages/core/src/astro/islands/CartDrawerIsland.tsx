import { useCallback, useEffect, useState } from "react";

/**
 * Slide-in cart drawer used by the storefront header.
 *
 *   - Mounts at `client:load` so the cart badge updates on every page.
 *   - Listens for `window` event `dashcommerce:cart-updated` to re-fetch
 *     and pop open on add-to-cart. A `{ silent: true }` detail suppresses
 *     the auto-open (used by `/thank-you` after checkout).
 *   - Inline edits: quantity +/-, remove line, clear cart. All mutations
 *     go through the same API the full cart page uses so server-side
 *     recalculation, coupons, and shipping stay in sync.
 *
 * Errors are surfaced in a small banner under the item list. We don't
 * auto-dismiss — the caller can retry or close the drawer.
 */

interface Money {
	currency: string;
	amount: number;
}

interface CartLine {
	lineId: string;
	productId: string;
	variantId?: string;
	quantity: number;
	unitPrice: Money;
	lineSubtotal: Money;
	title: string;
}

interface CartState {
	items: CartLine[];
	subtotal: Money;
	total: Money;
	currency: string;
}

function formatMoney(m: Money, locale = "en-US") {
	try {
		return new Intl.NumberFormat(locale, {
			style: "currency",
			currency: m.currency,
		}).format(m.amount / 100);
	} catch {
		return `${m.currency} ${m.amount / 100}`;
	}
}

const API = "/_emdash/api/plugins/dashcommerce";

export interface CartDrawerIslandProps {
	checkoutHref?: string;
	cartHref?: string;
}

export default function CartDrawerIsland({
	checkoutHref = "/checkout",
	cartHref = "/cart",
}: CartDrawerIslandProps) {
	const [open, setOpen] = useState(false);
	const [cart, setCart] = useState<CartState | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const res = await fetch(`${API}/cart`, { credentials: "include" });
			if (!res.ok) return;
			const body = (await res.json()) as { cart: CartState };
			setCart(body.cart);
			setError(null);
		} catch {
			// Silent — cart missing or network error.
		}
	}, []);

	useEffect(() => {
		reload();
		const onUpdate = (e: Event) => {
			reload();
			const silent = Boolean(
				(e as CustomEvent<{ silent?: boolean } | undefined>).detail?.silent,
			);
			if (!silent) setOpen(true);
		};
		window.addEventListener("dashcommerce:cart-updated", onUpdate);
		return () =>
			window.removeEventListener("dashcommerce:cart-updated", onUpdate);
	}, [reload]);

	async function applyCart(next: CartState | null) {
		if (!next) return;
		setCart(next);
	}

	async function updateQuantity(lineId: string, quantity: number) {
		if (quantity < 0) return;
		setPending(true);
		setError(null);
		try {
			const res = await fetch(
				`${API}/cart/item?lineId=${encodeURIComponent(lineId)}`,
				{
					method: "PATCH",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ quantity }),
				},
			);
			const body = (await res.json().catch(() => ({}))) as {
				cart?: CartState;
				error?: string;
			};
			if (!res.ok) {
				setError(body.error ?? `Update failed (${res.status})`);
				return;
			}
			applyCart(body.cart ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setPending(false);
		}
	}

	async function removeLine(lineId: string) {
		setPending(true);
		setError(null);
		try {
			const res = await fetch(
				`${API}/cart/item?lineId=${encodeURIComponent(lineId)}`,
				{ method: "DELETE", credentials: "include" },
			);
			const body = (await res.json().catch(() => ({}))) as {
				cart?: CartState;
				error?: string;
			};
			if (!res.ok) {
				setError(body.error ?? `Remove failed (${res.status})`);
				return;
			}
			applyCart(body.cart ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setPending(false);
		}
	}

	async function clearCart() {
		const confirmed = window.confirm(
			"Remove everything from your cart?",
		);
		if (!confirmed) return;
		setPending(true);
		setError(null);
		try {
			const res = await fetch(`${API}/cart/clear`, {
				method: "DELETE",
				credentials: "include",
			});
			const body = (await res.json().catch(() => ({}))) as {
				cart?: CartState;
				error?: string;
			};
			if (!res.ok) {
				setError(body.error ?? `Clear failed (${res.status})`);
				return;
			}
			applyCart(body.cart ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setPending(false);
		}
	}

	const itemCount = cart?.items.reduce((s, i) => s + i.quantity, 0) ?? 0;

	return (
		<>
			<button
				type="button"
				className="dc-cart-trigger"
				onClick={() => setOpen(!open)}
				aria-label="Cart"
			>
				Cart {itemCount > 0 && <span>({itemCount})</span>}
			</button>
			{open && (
				<aside className="dc-cart-drawer" aria-label="Shopping cart">
					<header>
						<h3>Cart</h3>
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="Close"
						>
							×
						</button>
					</header>

					{error && (
						<div className="dc-cart-error" role="alert">
							{error}
						</div>
					)}

					{cart && cart.items.length > 0 ? (
						<>
							<ul>
								{cart.items.map((it) => (
									<li key={it.lineId}>
										<div className="dc-line-top">
											<span className="dc-line-title">{it.title}</span>
											<span className="dc-line-total">
												{formatMoney(it.lineSubtotal)}
											</span>
										</div>
										<div className="dc-line-bottom">
											<div
												className="dc-qty-controls"
												role="group"
												aria-label={`Quantity of ${it.title}`}
											>
												<button
													type="button"
													aria-label={`Decrease quantity of ${it.title}`}
													disabled={pending || it.quantity <= 1}
													onClick={() => updateQuantity(it.lineId, it.quantity - 1)}
												>
													−
												</button>
												<span className="dc-qty-val" aria-live="polite">
													{it.quantity}
												</span>
												<button
													type="button"
													aria-label={`Increase quantity of ${it.title}`}
													disabled={pending}
													onClick={() => updateQuantity(it.lineId, it.quantity + 1)}
												>
													+
												</button>
											</div>
											<button
												type="button"
												className="dc-remove"
												aria-label={`Remove ${it.title}`}
												title="Remove"
												disabled={pending}
												onClick={() => removeLine(it.lineId)}
											>
												×
											</button>
										</div>
									</li>
								))}
							</ul>
							<footer>
								<div className="dc-total-row dc-grand">
									<strong>Total</strong>
									<strong>{formatMoney(cart.total)}</strong>
								</div>
								<a className="dc-checkout-button" href={checkoutHref}>
									Checkout
								</a>
								<div className="dc-cart-secondary">
									<a href={cartHref} className="dc-view-cart">
										View cart →
									</a>
									<button
										type="button"
										className="dc-clear-cart"
										onClick={clearCart}
										disabled={pending}
										aria-label="Clear cart"
									>
										Clear cart
									</button>
								</div>
							</footer>
						</>
					) : (
						<div className="dc-cart-drawer-empty">
							<p>Your cart is empty.</p>
							<a
								href="/shop"
								className="dc-checkout-button"
								onClick={() => setOpen(false)}
							>
								Continue shopping
							</a>
						</div>
					)}
				</aside>
			)}
			<style>{`
        /* Uses site :root tokens (see starter global.css) with light fallbacks */
        .dc-cart-trigger {
          background: transparent;
          border: 0;
          cursor: pointer;
          font: inherit;
          font-family: var(--font-sans, inherit);
          color: var(--text, inherit);
        }
        .dc-cart-drawer {
          position: fixed;
          top: 0;
          right: 0;
          height: 100vh;
          width: 340px;
          max-width: 100vw;
          background: var(--surface, #fff);
          color: var(--text, #1a1a1a);
          box-shadow: -8px 0 40px rgba(0, 0, 0, 0.35);
          border-left: 1px solid var(--border, rgba(0, 0, 0, 0.08));
          padding: 0.9rem 1rem;
          display: flex;
          flex-direction: column;
          overflow-y: auto;
          z-index: 1000;
          font-family: var(--font-sans, system-ui, sans-serif);
        }
        .dc-cart-drawer header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
          gap: 0.5rem;
        }
        .dc-cart-drawer header h3 {
          margin: 0;
          font-family: var(--font-display, var(--font-sans, serif));
          font-size: 1.05rem;
          font-weight: 700;
          color: var(--text);
        }
        .dc-cart-drawer header button {
          background: none;
          border: none;
          cursor: pointer;
          font-size: 1.4rem;
          line-height: 1;
          color: var(--text-muted, #666);
          padding: 0.15rem 0.35rem;
        }
        .dc-cart-drawer header button:hover { color: var(--text); }
        .dc-cart-drawer ul {
          list-style: none;
          padding: 0;
          margin: 0;
          flex: 1;
        }
        .dc-cart-drawer li {
          padding: 0.55rem 0;
          border-bottom: 1px solid var(--border, #eee);
        }
        .dc-line-top {
          display: flex;
          justify-content: space-between;
          gap: 0.5rem;
          align-items: baseline;
        }
        .dc-line-title {
          font-weight: 600;
          color: var(--text);
          font-size: 0.9rem;
          overflow-wrap: anywhere;
        }
        .dc-line-total {
          font-family: var(--font-mono, ui-monospace, monospace);
          color: var(--gold, var(--accent, inherit));
          font-size: 0.88rem;
          white-space: nowrap;
          font-weight: 600;
        }
        .dc-line-bottom {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-top: 0.25rem;
        }
        .dc-qty-controls {
          display: inline-flex;
          align-items: center;
          gap: 0;
          border: 1px solid var(--border-mid, var(--border-strong, #d4d4d8));
          border-radius: 4px;
          overflow: hidden;
          background: var(--surface, #fff);
        }
        .dc-qty-controls button {
          width: 1.6rem; height: 1.5rem;
          border: 0;
          background: transparent;
          color: var(--text, #111);
          cursor: pointer;
          font-size: 0.9rem;
          line-height: 1;
          padding: 0;
        }
        .dc-qty-controls button:hover:not(:disabled) { background: var(--bg-3, #f4f4f5); }
        .dc-qty-controls button:disabled { opacity: 0.3; cursor: not-allowed; }
        .dc-qty-val {
          min-width: 1.4rem;
          text-align: center;
          font-size: 0.82rem;
          color: var(--text, #111);
          font-variant-numeric: tabular-nums;
          border-left: 1px solid var(--border, #eee);
          border-right: 1px solid var(--border, #eee);
          padding: 0 0.3rem;
          line-height: 1.5rem;
        }
        .dc-remove {
          background: transparent;
          border: 0;
          cursor: pointer;
          color: var(--text-muted, #888);
          font-size: 1.05rem;
          line-height: 1;
          padding: 0.2rem 0.45rem;
          border-radius: 3px;
        }
        .dc-remove:hover:not(:disabled) {
          color: var(--ember, #a00);
          background: var(--bg-3, rgba(0,0,0,0.04));
        }
        .dc-remove:disabled { opacity: 0.4; cursor: not-allowed; }
        .dc-cart-drawer-empty {
          margin: 1rem 0;
          color: var(--text-muted, #666);
          text-align: center;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .dc-cart-drawer-empty p { margin: 0; font-size: 0.9rem; }
        .dc-cart-error {
          background: var(--ember-bg, rgba(200, 60, 60, 0.08));
          color: var(--ember, #a00);
          padding: 0.4rem 0.6rem;
          border-radius: var(--radius, 4px);
          font-size: 0.8rem;
          margin-bottom: 0.5rem;
        }
        .dc-total-row {
          display: flex;
          justify-content: space-between;
          padding: 0.15rem 0;
          color: var(--text);
        }
        .dc-total-row.dc-grand {
          font-size: 1rem;
          padding-top: 0.5rem;
          border-top: 1px solid var(--border-mid, var(--border, #eee));
          margin-top: 0.25rem;
        }
        .dc-total-row.dc-grand strong:last-child {
          font-family: var(--font-mono, ui-monospace, monospace);
          color: var(--gold, var(--accent, inherit));
        }
        .dc-checkout-button {
          display: block;
          text-align: center;
          padding: 0.65rem 1rem;
          background: var(--gold, #111);
          color: var(--accent-on, #fff);
          text-decoration: none;
          border-radius: var(--radius, 6px);
          margin-top: 0.65rem;
          font-size: 0.9rem;
          font-weight: 600;
          transition: background 0.2s ease;
        }
        .dc-checkout-button:hover {
          background: var(--gold-light, #333);
          color: var(--accent-on, #fff);
        }
        .dc-cart-secondary {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          margin-top: 0.5rem;
          font-size: 0.82rem;
        }
        .dc-view-cart {
          color: var(--text, #111);
          font-weight: 600;
          text-decoration: none;
          padding: 0.4rem 0.6rem;
          border-radius: var(--radius, 4px);
          border: 1px solid var(--border-mid, var(--border-strong, #d4d4d8));
          background: var(--surface, #fff);
          transition: background 0.15s ease, border-color 0.15s ease;
        }
        .dc-view-cart:hover {
          background: var(--bg-3, #f4f4f5);
          border-color: var(--text-muted, #999);
        }
        .dc-clear-cart {
          background: transparent;
          border: 1px solid transparent;
          cursor: pointer;
          color: var(--ember, #c0392b);
          font-size: inherit;
          font-weight: 600;
          padding: 0.4rem 0.6rem;
          border-radius: var(--radius, 4px);
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
        }
        .dc-clear-cart:hover:not(:disabled) {
          background: var(--ember-bg, rgba(200, 60, 60, 0.1));
          border-color: var(--ember, #c0392b);
          color: var(--ember, #a00);
        }
        .dc-clear-cart:disabled { opacity: 0.4; cursor: not-allowed; }
      `}</style>
		</>
	);
}

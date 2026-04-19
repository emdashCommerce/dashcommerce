import { useEffect, useRef, useState } from "react";

interface Money {
	currency: string;
	amount: number;
}
interface Item {
	id: string;
	name: string;
	quantity: number;
	total: Money;
}
interface Order {
	id: string;
	orderNumber: string;
	status: string;
	customerEmail: string;
	total: Money;
	currency: string;
}
type PollResponse =
	| { status: "ready"; order: Order; items: Item[] }
	| { status: "pending" }
	| { status: "failed" };

export interface OrderSummaryIslandProps {
	orderDraftId: string;
	pollIntervalMs?: number;
	maxDurationMs?: number;
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

export default function OrderSummaryIsland({
	orderDraftId,
	pollIntervalMs = 800,
	maxDurationMs = 60_000,
}: OrderSummaryIslandProps) {
	const [result, setResult] = useState<PollResponse | null>(null);
	const [timedOut, setTimedOut] = useState(false);
	const timerRef = useRef<number | null>(null);
	const notifiedRef = useRef(false);

	useEffect(() => {
		const deadline = Date.now() + maxDurationMs;
		async function poll() {
			if (Date.now() > deadline) {
				setTimedOut(true);
				// Give any lingering cart UI a chance to drop stale items
				// even if order polling timed out — the webhook may have
				// arrived after our window closed.
				if (!notifiedRef.current) {
					notifiedRef.current = true;
					window.dispatchEvent(
						new CustomEvent("dashcommerce:cart-updated", {
							detail: { silent: true },
						}),
					);
				}
				return;
			}
			try {
				const res = await fetch(
					`/_emdash/api/plugins/dashcommerce/orders/by-draft?id=${encodeURIComponent(orderDraftId)}`,
					{ credentials: "include" },
				);
				const body = (await res.json()) as PollResponse;
				if (body.status === "ready" || body.status === "failed") {
					setResult(body);
					// Order persisted → webhook fired → server-side cart
					// has been cleared. Broadcast so CartDrawerIsland /
					// CartPageIsland refetch and render an empty cart.
					if (!notifiedRef.current) {
						notifiedRef.current = true;
						window.dispatchEvent(
							new CustomEvent("dashcommerce:cart-updated", {
								detail: { silent: true },
							}),
						);
					}
					return;
				}
				setResult(body);
				timerRef.current = window.setTimeout(poll, pollIntervalMs);
			} catch {
				timerRef.current = window.setTimeout(poll, pollIntervalMs);
			}
		}
		poll();
		return () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		};
	}, [orderDraftId, pollIntervalMs, maxDurationMs]);

	if (timedOut) {
		return (
			<div role="alert">
				<h2>Processing your payment</h2>
				<p>
					Your payment is still being confirmed. You'll receive a receipt email
					shortly. If you have any concern, contact support with reference{" "}
					<code>{orderDraftId}</code>.
				</p>
			</div>
		);
	}

	if (!result || result.status === "pending") {
		return (
			<div>
				<h2>Confirming your order…</h2>
				<p>Hold on, we're finalizing your payment.</p>
			</div>
		);
	}

	if (result.status === "failed") {
		return (
			<div role="alert">
				<h2>We couldn't confirm your payment</h2>
				<p>
					If you were charged, please contact support with reference{" "}
					<code>{orderDraftId}</code>.
				</p>
			</div>
		);
	}

	const { order, items } = result;
	return (
		<section className="dc-order-summary">
			<h2>Thanks for your order, #{order.orderNumber}</h2>
			<p>
				A receipt has been sent to <strong>{order.customerEmail}</strong>.
			</p>
			<ul>
				{items.map((it) => (
					<li key={it.id}>
						{it.quantity} × {it.name} — {formatMoney(it.total)}
					</li>
				))}
			</ul>
			<p className="dc-total">
				<strong>Total:</strong> {formatMoney(order.total)}
			</p>
			<style>{`
        .dc-order-summary {
          max-width: 32rem;
          margin: 2rem auto;
          padding: 2rem;
          background: var(--success-bg, rgba(76, 175, 120, 0.08));
          border: 1px solid var(--success, #b8d9bf);
          border-radius: var(--radius-lg, 8px);
          color: var(--text, #111);
        }
        .dc-order-summary ul {
          list-style: none;
          padding: 0;
        }
        .dc-order-summary li {
          padding: 0.5rem 0;
          border-bottom: 1px solid var(--border-mid, rgba(76, 175, 120, 0.25));
          color: var(--text, #111);
        }
        .dc-total {
          font-size: 1.2em;
          margin-top: 1rem;
          color: var(--text, #111);
        }
      `}</style>
		</section>
	);
}

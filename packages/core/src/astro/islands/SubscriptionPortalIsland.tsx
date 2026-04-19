import { useEffect, useState } from "react";

/**
 * Subscription self-service island.
 *
 * Customers arrive here via a signed token link emailed with their
 * subscription receipt (`/account/subscription?token=…`). The token
 * proves ownership; no login is required (DashCommerce uses
 * email-gated accounts).
 *
 * In addition to the local Cancel / Pause / Resume actions (which
 * forward to Stripe), we expose a "Manage billing" button that
 * redirects to the Stripe-hosted Billing Portal — customers can
 * update their card, download invoices, and manage billing there
 * without us having to implement those screens ourselves.
 */

interface Money {
	currency: string;
	amount: number;
}
interface Subscription {
	id: string;
	status: string;
	currency: string;
	unitAmount: Money;
	interval: string;
	intervalCount: number;
	currentPeriodEnd: string;
	cancelAtPeriodEnd: boolean;
}

export interface SubscriptionPortalIslandProps {
	token: string;
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

export default function SubscriptionPortalIsland({
	token,
}: SubscriptionPortalIslandProps) {
	const [sub, setSub] = useState<Subscription | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function reload() {
		try {
			const res = await fetch(
				`${API}/subscriptions/state?token=${encodeURIComponent(token)}`,
				{ credentials: "include" },
			);
			const body = (await res.json()) as {
				subscription?: Subscription;
				error?: string;
			};
			if (!res.ok) {
				setError(body.error ?? "Invalid link");
				return;
			}
			setSub(body.subscription ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		}
	}

	useEffect(() => {
		reload();
	}, []);

	async function act(action: "cancel" | "pause" | "resume") {
		setPending(true);
		setError(null);
		try {
			const res = await fetch(`${API}/subscriptions/${action}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token,
					...(action === "cancel" ? { mode: "at_period_end" } : {}),
				}),
			});
			const body = (await res.json()) as { error?: string };
			if (!res.ok) {
				setError(body.error ?? "Action failed");
			} else {
				await reload();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setPending(false);
		}
	}

	async function openPortal() {
		setPending(true);
		setError(null);
		try {
			const res = await fetch(`${API}/subscriptions/portal`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token, returnUrl: window.location.href }),
			});
			const body = (await res.json()) as { url?: string; error?: string };
			if (!res.ok || !body.url) {
				setError(body.error ?? "Could not open billing portal");
				setPending(false);
				return;
			}
			window.location.href = body.url;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
			setPending(false);
		}
	}

	if (error) return <p role="alert">{error}</p>;
	if (!sub) return <p>Loading subscription…</p>;

	return (
		<section className="dc-sub-portal">
			<h2>Your subscription</h2>
			<p>
				<strong>Status:</strong> {sub.status}
			</p>
			<p>
				<strong>Price:</strong> {formatMoney(sub.unitAmount)} every{" "}
				{sub.intervalCount > 1 ? `${sub.intervalCount} ` : ""}
				{sub.interval}
			</p>
			<p>
				<strong>Next billed:</strong>{" "}
				{new Date(sub.currentPeriodEnd).toLocaleDateString()}
			</p>
			{sub.cancelAtPeriodEnd && (
				<p className="dc-notice">
					This subscription is set to cancel at the end of the period.
				</p>
			)}
			<div className="dc-actions">
				{!sub.cancelAtPeriodEnd && sub.status !== "canceled" && (
					<button type="button" onClick={() => act("cancel")} disabled={pending}>
						Cancel at period end
					</button>
				)}
				{sub.status !== "canceled" && sub.status !== "paused" && (
					<button type="button" onClick={() => act("pause")} disabled={pending}>
						Pause
					</button>
				)}
				{sub.status === "paused" && (
					<button type="button" onClick={() => act("resume")} disabled={pending}>
						Resume
					</button>
				)}
				<button
					type="button"
					onClick={openPortal}
					disabled={pending}
					className="dc-actions-secondary"
				>
					Manage billing on Stripe →
				</button>
			</div>
		</section>
	);
}

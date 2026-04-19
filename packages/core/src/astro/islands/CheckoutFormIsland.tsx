/**
 * CheckoutFormIsland — Stripe Elements checkout.
 *
 * Flow:
 *   1. Wait until the cart has `customerEmail` + `shippingAddress` set
 *      (the contact form on /checkout saves those, then dispatches
 *      `dashcommerce:cart-updated`). This keeps us from firing
 *      /checkout/create-intent before the customer has entered details
 *      — which previously surfaced a stale "customerEmail is required"
 *      error in the payment step.
 *   2. POST /checkout/create-intent → { clientSecret, orderDraftId }.
 *   3. Render <Elements> with the clientSecret.
 *   4. On submit, call stripe.confirmPayment with
 *      return_url = returnUrl with "{orderDraftId}" substituted.
 *   5. Stripe handles 3DS + redirects the customer back to the
 *      thank-you page, which polls /orders/by-draft/:id.
 *
 * Peer-optional: @stripe/react-stripe-js + @stripe/stripe-js are lazy-
 * imported inside the island so sites that don't use DashCommerce
 * checkout don't need to install them.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

export interface CheckoutFormIslandProps {
	publishableKey: string;
	returnUrl: string;
}

interface IntentResponse {
	clientSecret: string;
	orderDraftId: string;
	paymentIntentId: string;
}

interface CartContactSnapshot {
	customerEmail?: string;
	shippingAddress?: unknown;
}

async function fetchCartReady(): Promise<boolean> {
	try {
		const res = await fetch("/_emdash/api/plugins/dashcommerce/cart", {
			credentials: "include",
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { cart?: CartContactSnapshot };
		const cart = body.cart ?? {};
		return Boolean(
			cart.customerEmail &&
				cart.customerEmail.includes("@") &&
				cart.shippingAddress,
		);
	} catch {
		return false;
	}
}

export default function CheckoutFormIsland({
	publishableKey,
	returnUrl,
}: CheckoutFormIslandProps) {
	const [intent, setIntent] = useState<IntentResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [stripeModule, setStripeModule] =
		useState<typeof import("@stripe/react-stripe-js") | null>(null);
	const [stripePromise, setStripePromise] = useState<
		ReturnType<typeof import("@stripe/stripe-js").loadStripe> | null
	>(null);
	const startedRef = useRef(false);

	const start = useCallback(async () => {
		if (startedRef.current) return;
		startedRef.current = true;
		setError(null);
		try {
			const [reactStripe, stripeJs] = await Promise.all([
				import("@stripe/react-stripe-js"),
				import("@stripe/stripe-js"),
			]);
			setStripeModule(reactStripe);
			setStripePromise(stripeJs.loadStripe(publishableKey));
			const res = await fetch(
				"/_emdash/api/plugins/dashcommerce/checkout/create-intent",
				{
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				},
			);
			const body = (await res.json()) as IntentResponse | { error?: string };
			if (!res.ok) {
				// Let the customer retry once they fix whatever's missing.
				startedRef.current = false;
				setError(("error" in body && body.error) || "Could not start checkout");
				return;
			}
			setIntent(body as IntentResponse);
		} catch (err) {
			startedRef.current = false;
			setError(err instanceof Error ? err.message : "Could not start checkout");
		}
	}, [publishableKey]);

	useEffect(() => {
		let cancelled = false;

		async function maybeStart() {
			if (startedRef.current || cancelled) return;
			const ready = await fetchCartReady();
			if (ready && !cancelled) void start();
		}

		void maybeStart();

		const onCartUpdated = () => {
			void maybeStart();
		};
		window.addEventListener("dashcommerce:cart-updated", onCartUpdated);
		return () => {
			cancelled = true;
			window.removeEventListener("dashcommerce:cart-updated", onCartUpdated);
		};
	}, [start]);

	if (error) return <div role="alert">Checkout unavailable: {error}</div>;
	if (!intent || !stripeModule || !stripePromise) {
		return <div>Loading checkout…</div>;
	}

	const { Elements } = stripeModule;
	const finalReturnUrl = returnUrl.replace("{orderDraftId}", intent.orderDraftId);

	return (
		<Elements
			stripe={stripePromise}
			options={{ clientSecret: intent.clientSecret }}
		>
			<InnerForm returnUrl={finalReturnUrl} stripeModule={stripeModule} />
		</Elements>
	);
}

function InnerForm({
	returnUrl,
	stripeModule,
}: {
	returnUrl: string;
	stripeModule: typeof import("@stripe/react-stripe-js");
}) {
	const { PaymentElement, useStripe, useElements } = stripeModule;
	const stripe = useStripe();
	const elements = useElements();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		if (!stripe || !elements) return;
		setSubmitting(true);
		setError(null);
		const { error } = await stripe.confirmPayment({
			elements,
			confirmParams: { return_url: returnUrl },
		});
		if (error) {
			setError(error.message ?? "Payment failed");
		}
		setSubmitting(false);
	}

	return (
		<form onSubmit={onSubmit} className="dc-checkout-form">
			<PaymentElement />
			<button
				type="submit"
				className="dc-checkout-form__submit"
				disabled={!stripe || submitting}
			>
				{submitting ? "Processing…" : "Pay now"}
			</button>
			{error && (
				<p role="alert" className="dc-checkout-form__error">
					{error}
				</p>
			)}
			<style>{`
				.dc-checkout-form__submit {
					margin-top: 16px;
					padding: 0.75rem 1.5rem;
					background: var(--accent, var(--gold, #111));
					color: var(--accent-on, #fff);
					border: 0;
					border-radius: var(--radius, 4px);
					cursor: pointer;
					font-weight: 500;
					transition: background .2s, filter .2s;
				}
				.dc-checkout-form__submit:hover:not(:disabled) {
					background: var(--gold-light, var(--accent, #333));
					filter: brightness(1.08);
				}
				.dc-checkout-form__submit:disabled { opacity: 0.6; cursor: not-allowed; }
				.dc-checkout-form__error { color: var(--ember, #a00); }
			`}</style>
		</form>
	);
}

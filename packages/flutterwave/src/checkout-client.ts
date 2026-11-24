/**
 * Browser side of Flutterwave on-page checkout (Flutterwave Inline).
 *
 * A storefront imports this once, in its checkout page's client script:
 *
 *   import "@dashcommerce/flutterwave/checkout-client";
 *
 * which registers the client on `window.DashCommerceCheckoutClients.flutterwave`.
 * DashCommerce's checkout form calls it with the details from create-session.
 * `checkout.flutterwave.com/v3.js` is loaded only then, never on page load.
 * The callbacks only move the customer along: the order is created by the
 * signed webhook and a live verify, never by the browser.
 *
 * Runs in the browser only; nothing here may be imported by the provider.
 */

import type { OnPageCheckoutClient } from "@dashcommerce/core/payment-provider";

export const FLUTTERWAVE_INLINE_SCRIPT = "https://checkout.flutterwave.com/v3.js";

interface FlutterwaveCheckoutOptions {
	public_key: string;
	tx_ref: string;
	amount: number;
	currency: string;
	customer: { email: string; name?: string; phone_number?: string };
	meta?: Record<string, string>;
	payment_options?: string;
	subaccounts?: Array<{
		id: string;
		transaction_charge_type?: string;
		transaction_charge?: number;
	}>;
	callback?: (payment: unknown) => void;
	onclose?: (incomplete: boolean) => void;
}

interface FlutterwaveCheckoutInstance {
	close?: () => void;
}

type WindowWithFlutterwave = Window & {
	FlutterwaveCheckout?: (
		options: FlutterwaveCheckoutOptions,
	) => FlutterwaveCheckoutInstance | undefined;
	DashCommerceCheckoutClients?: Record<string, OnPageCheckoutClient>;
};

/** Build the client for a given window and document (tests pass stand-ins). */
export function createFlutterwaveCheckoutClient(win: Window, doc: Document): OnPageCheckoutClient {
	const w = win as WindowWithFlutterwave;
	let loading: Promise<void> | null = null;

	function loadScript(): Promise<void> {
		if (w.FlutterwaveCheckout) return Promise.resolve();
		if (!loading) {
			loading = new Promise<void>((resolve, reject) => {
				const script = doc.createElement("script");
				script.src = FLUTTERWAVE_INLINE_SCRIPT;
				script.async = true;
				script.onload = () => resolve();
				script.onerror = () => reject(new Error("script failed"));
				doc.head.appendChild(script);
			}).catch((err) => {
				loading = null; // let a retry load it again
				throw err;
			});
		}
		return loading;
	}

	return {
		open(client, callbacks) {
			const publicKey = client.publicKey;
			const txRef = client.txRef;
			const currency = client.currency;
			const email = client.customerEmail;
			const amount = Number(client.amount);
			if (!publicKey || !txRef || !currency || !email || !Number.isFinite(amount)) {
				callbacks.onError("Flutterwave did not return the checkout details");
				return;
			}

			// The server sends the split as JSON so the client payload stays a
			// flat map of strings. A malformed value must not open a payment
			// that would settle entirely to the platform.
			let subaccounts: FlutterwaveCheckoutOptions["subaccounts"];
			if (client.subaccounts) {
				try {
					const parsed = JSON.parse(client.subaccounts) as unknown;
					if (!Array.isArray(parsed)) throw new Error("not an array");
					subaccounts = parsed as FlutterwaveCheckoutOptions["subaccounts"];
				} catch {
					callbacks.onError("Flutterwave split details are invalid");
					return;
				}
			}

			loadScript().then(
				() => {
					if (!w.FlutterwaveCheckout) {
						callbacks.onError("Could not load Flutterwave. Check your connection and try again.");
						return;
					}
					// `redirect_url` takes precedence over `callback` in Inline, so it
					// is deliberately omitted: the callback moves the customer.
					let settled = false;
					const finish = () => {
						if (settled) return;
						settled = true;
						callbacks.onFinished();
					};
					const close = () => {
						if (settled) return;
						settled = true;
						callbacks.onClosed();
					};
					try {
						w.FlutterwaveCheckout({
							public_key: publicKey,
							tx_ref: txRef,
							amount,
							currency,
							customer: {
								email,
								...(client.customerName ? { name: client.customerName } : {}),
								...(client.customerPhone ? { phone_number: client.customerPhone } : {}),
							},
							...(client.orderDraftId ? { meta: { orderDraftId: client.orderDraftId } } : {}),
							...(client.paymentOptions ? { payment_options: client.paymentOptions } : {}),
							...(subaccounts && subaccounts.length > 0 ? { subaccounts } : {}),
							callback: () => finish(),
							onclose: () => close(),
						});
					} catch (err) {
						callbacks.onError(
							err instanceof Error ? err.message : "Flutterwave could not start the payment",
						);
					}
				},
				() => callbacks.onError("Could not load Flutterwave. Check your connection and try again."),
			);
		},
	};
}

/** Put the Flutterwave client next to any other providers' clients. */
export function registerFlutterwaveCheckoutClient(win: Window, doc: Document): void {
	const w = win as WindowWithFlutterwave;
	w.DashCommerceCheckoutClients = {
		...(w.DashCommerceCheckoutClients ?? {}),
		flutterwave: createFlutterwaveCheckoutClient(win, doc),
	};
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	registerFlutterwaveCheckoutClient(window, document);
}

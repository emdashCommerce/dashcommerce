/**
 * Browser side of Paystack on-page checkout (the Popup).
 *
 * A storefront imports this once, in its checkout page's client script:
 *
 *   import "@dashcommerce/paystack/checkout-client";
 *
 * which registers the client on `window.DashCommerceCheckoutClients.paystack`.
 * DashCommerce's checkout form calls it with the `accessCode` from
 * create-session. Paystack's `inline.js` is loaded only then, never on page
 * load. The callbacks only move the customer along: the order is created by
 * the signed webhook and a live verify, never by the browser.
 *
 * Runs in the browser only; nothing here may be imported by the provider.
 */

import type { OnPageCheckoutClient } from "@dashcommerce/core/payment-provider";

export const PAYSTACK_INLINE_SCRIPT = "https://js.paystack.co/v2/inline.js";

interface PaystackPopInstance {
	resumeTransaction(
		accessCode: string,
		callbacks: {
			onSuccess?: (transaction: unknown) => void;
			onCancel?: () => void;
			onError?: (error: { message?: string } | undefined) => void;
		},
	): void;
}

type WindowWithPaystack = Window & {
	PaystackPop?: new () => PaystackPopInstance;
	DashCommerceCheckoutClients?: Record<string, OnPageCheckoutClient>;
};

/** Build the client for a given window and document (tests pass stand-ins). */
export function createPaystackCheckoutClient(win: Window, doc: Document): OnPageCheckoutClient {
	const w = win as WindowWithPaystack;
	let loading: Promise<void> | null = null;

	function loadScript(): Promise<void> {
		if (w.PaystackPop) return Promise.resolve();
		if (!loading) {
			loading = new Promise<void>((resolve, reject) => {
				const script = doc.createElement("script");
				script.src = PAYSTACK_INLINE_SCRIPT;
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
			const accessCode = client.accessCode;
			if (!accessCode) {
				callbacks.onError("Paystack did not return an access code");
				return;
			}
			loadScript().then(
				() => {
					if (!w.PaystackPop) {
						callbacks.onError("Could not load Paystack. Check your connection and try again.");
						return;
					}
					new w.PaystackPop().resumeTransaction(accessCode, {
						onSuccess: () => callbacks.onFinished(),
						onCancel: () => callbacks.onClosed(),
						onError: (error) =>
							callbacks.onError(error?.message ?? "Paystack could not start the payment"),
					});
				},
				() => callbacks.onError("Could not load Paystack. Check your connection and try again."),
			);
		},
	};
}

/** Put the Paystack client next to any other providers' clients. */
export function registerPaystackCheckoutClient(win: Window, doc: Document): void {
	const w = win as WindowWithPaystack;
	w.DashCommerceCheckoutClients = {
		...(w.DashCommerceCheckoutClients ?? {}),
		paystack: createPaystackCheckoutClient(win, doc),
	};
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	registerPaystackCheckoutClient(window, document);
}

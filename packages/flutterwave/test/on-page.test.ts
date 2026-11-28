/**
 * Flutterwave on-page checkout: Inline, opened over the store's checkout
 * with the public key and `tx_ref` from create-session.
 */

import { describe, expect, it } from "bun:test";
import {
	FLUTTERWAVE_INLINE_SCRIPT,
	createFlutterwaveCheckoutClient,
	registerFlutterwaveCheckoutClient,
} from "../src/checkout-client";

interface InlineOptions {
	public_key: string;
	tx_ref: string;
	amount: number;
	currency: string;
	customer: { email: string; name?: string; phone_number?: string };
	meta?: Record<string, string>;
	payment_options?: string;
	callback?: (payment: unknown) => void;
	onclose?: (incomplete: boolean) => void;
}

/** A minimal browser stand-in: script tags "load" when the test says so. */
function fakeBrowser() {
	const appended: Array<{ src: string; onload?: () => void; onerror?: () => void }> = [];
	const opened: InlineOptions[] = [];
	const win: Record<string, unknown> = {};
	const doc = {
		createElement: () =>
			({}) as { src: string; async?: boolean; onload?: () => void; onerror?: () => void },
		head: {
			appendChild: (el: { src: string; onload?: () => void; onerror?: () => void }) => {
				appended.push(el);
			},
		},
	};
	return {
		win,
		doc,
		appended,
		opened,
		loadScript() {
			win.FlutterwaveCheckout = (options: InlineOptions) => {
				opened.push(options);
				return { close() {} };
			};
			for (const el of appended) el.onload?.();
		},
		failScript() {
			for (const el of appended) el.onerror?.();
		},
	};
}

function recorder() {
	const events: string[] = [];
	return {
		events,
		callbacks: {
			onFinished: () => events.push("finished"),
			onClosed: () => events.push("closed"),
			onError: (m: string) => events.push(`error:${m}`),
		},
	};
}

const clientData = {
	publicKey: "FLWPUBK_TEST-abc123-X",
	txRef: "dc-0123456789abcdef0123456789abcdef",
	amount: "2500",
	currency: "KES",
	customerEmail: "fan@example.com",
	customerName: "Aidi Onyango",
	customerPhone: "+254700000000",
	paymentOptions: "card,mpesa",
	orderDraftId: "0123456789abcdef0123456789abcdef",
};

describe("Flutterwave checkout client", () => {
	it("loads v3.js only when opened, then starts Inline with the client data", async () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		expect(b.appended).toHaveLength(0);

		const r = recorder();
		client.open(clientData, r.callbacks);
		expect(b.appended.map((s) => s.src)).toEqual([FLUTTERWAVE_INLINE_SCRIPT]);
		b.loadScript();
		await Promise.resolve();
		await Promise.resolve();

		expect(b.opened).toHaveLength(1);
		const options = b.opened[0];
		if (!options) throw new Error("Inline was not opened");
		expect(options.public_key).toBe("FLWPUBK_TEST-abc123-X");
		expect(options.tx_ref).toBe(clientData.txRef);
		expect(options.amount).toBe(2500);
		expect(options.currency).toBe("KES");
		expect(options.customer).toEqual({
			email: "fan@example.com",
			name: "Aidi Onyango",
			phone_number: "+254700000000",
		});
		expect(options.meta).toEqual({ orderDraftId: clientData.orderDraftId });
		expect(options.payment_options).toBe("card,mpesa");
		// redirect_url would take precedence over the callback, so it is omitted.
		expect("redirect_url" in options).toBe(false);

		options.callback?.({ status: "successful" });
		expect(r.events).toEqual(["finished"]);
	});

	it("moves the customer on only once, even when onclose follows the callback", async () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open(clientData, r.callbacks);
		b.loadScript();
		await Promise.resolve();
		await Promise.resolve();

		const options = b.opened[0];
		if (!options) throw new Error("Inline was not opened");
		options.callback?.({});
		options.onclose?.(false);
		expect(r.events).toEqual(["finished"]);
	});

	it("reports a closed modal as not completed", async () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open(clientData, r.callbacks);
		b.loadScript();
		await Promise.resolve();
		await Promise.resolve();

		b.opened[0]?.onclose?.(true);
		expect(r.events).toEqual(["closed"]);
	});

	it("reuses the loaded script for a second attempt", async () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open(clientData, r.callbacks);
		b.loadScript();
		await Promise.resolve();
		await Promise.resolve();
		client.open({ ...clientData, txRef: "dc-second" }, r.callbacks);
		await Promise.resolve();
		await Promise.resolve();
		expect(b.appended).toHaveLength(1);
		expect(b.opened.map((o) => o.tx_ref)).toEqual([clientData.txRef, "dc-second"]);
	});

	it("says so when the script can't load, and lets the customer retry", async () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open(clientData, r.callbacks);
		b.failScript();
		await Promise.resolve();
		await Promise.resolve();
		expect(r.events[0]).toMatch(/^error:Could not load Flutterwave/);

		client.open(clientData, r.callbacks);
		expect(b.appended).toHaveLength(2);
	});

	it("reports a throw from Inline instead of leaving the form spinning", async () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		b.win.FlutterwaveCheckout = () => {
			throw new Error("bad key");
		};
		const r = recorder();
		client.open(clientData, r.callbacks);
		await Promise.resolve();
		await Promise.resolve();
		expect(r.events).toEqual(["error:bad key"]);
	});

	it("refuses to open without the data Inline needs", () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open({ ...clientData, publicKey: "" }, r.callbacks);
		expect(r.events).toEqual(["error:Flutterwave did not return the checkout details"]);
		expect(b.appended).toHaveLength(0);
	});

	it("passes a server-provided split to Inline", async () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open(
			{
				...clientData,
				subaccounts: JSON.stringify([
					{ id: "RS_V1", transaction_charge_type: "flat_subaccount", transaction_charge: 900 },
				]),
			},
			r.callbacks,
		);
		b.loadScript();
		await Promise.resolve();
		await Promise.resolve();
		expect(b.opened[0]?.subaccounts).toEqual([
			{ id: "RS_V1", transaction_charge_type: "flat_subaccount", transaction_charge: 900 },
		]);
	});

	it("refuses a malformed split instead of opening an unsplit payment", () => {
		const b = fakeBrowser();
		const client = createFlutterwaveCheckoutClient(
			b.win as unknown as Window,
			b.doc as unknown as Document,
		);
		const r = recorder();
		client.open({ ...clientData, subaccounts: "not json" }, r.callbacks);
		expect(r.events).toEqual(["error:Flutterwave split details are invalid"]);
		expect(b.appended).toHaveLength(0);
	});

	it("registers itself next to other providers' clients", () => {
		const b = fakeBrowser();
		const other = { open() {} };
		b.win.DashCommerceCheckoutClients = { acme: other };
		registerFlutterwaveCheckoutClient(b.win as unknown as Window, b.doc as unknown as Document);
		const clients = b.win.DashCommerceCheckoutClients as Record<string, unknown>;
		expect(clients.acme).toBe(other);
		expect(typeof (clients.flutterwave as { open: unknown }).open).toBe("function");
	});
});

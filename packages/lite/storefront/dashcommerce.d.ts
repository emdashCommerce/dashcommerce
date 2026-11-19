export declare const DEFAULT_BASE: string;
export declare const STORAGE_KEY: string;
export declare const CART_HEADER: string;
export declare const CART_EVENT: "dashcommerce:cart";
export declare const MAX_CHECKOUT_REQUESTS: number;

export interface Money {
	currency: string;
	/** Integer minor units, for example cents. */
	amount: number;
}

export interface CartLine {
	lineId: string;
	productId: string;
	title: string;
	quantity: number;
	unitPrice: Money;
	lineSubtotal: Money;
}

export interface Cart {
	currency: string;
	items: CartLine[];
	itemCount: number;
	subtotal: Money;
	/** Coupon discount on the item subtotal. */
	discountTotal: Money;
	/** The coupon on the cart; `applied` is false while the cart is below its minimum. */
	coupon: {
		code: string;
		type: "percent" | "fixed" | "free_shipping";
		value: number;
		applied: boolean;
		freeShipping: boolean;
		minSubtotal: Money | null;
	} | null;
	shippingTotal: Money;
	taxTotal: Money;
	total: Money;
	/** True when Stripe Tax adds tax on the Checkout page. */
	taxAtCheckout: boolean;
	updatedAt: string;
}

export interface CheckoutStart {
	ok: true;
	url: string;
	orderId: string;
	orderKey: string;
	orderNumber: string;
}

export interface PublicOrder {
	id: string;
	orderNumber: string;
	status: string;
	paymentStatus: "pending" | "paid" | "failed" | "refunded" | "partially-refunded";
	currency: string;
	items: Array<{
		productId: string;
		title: string;
		quantity: number;
		unitPrice: Money;
		lineTotal: Money;
	}>;
	subtotal: Money;
	discountTotal: Money;
	couponCode: string | null;
	shippingTotal: Money;
	taxTotal: Money;
	total: Money;
	refundedAmount: number;
	createdAt: string;
	paidAt: string | null;
}

export declare class DashCommerceError extends Error {
	code: string;
	details: Record<string, unknown> & { cart?: Cart };
	constructor(code: string, message: string, details?: Record<string, unknown>);
}

export interface ClientOptions {
	base?: string;
	storage?: {
		getItem(k: string): string | null;
		setItem(k: string, v: string): void;
		removeItem(k: string): void;
	};
	fetch?: typeof fetch;
	events?: EventTarget | null;
	storageKey?: string;
}

export interface DashCommerceClient {
	getToken(): string | null;
	clearToken(): void;
	getCart(): Promise<Cart>;
	addItem(productId: string, quantity?: number): Promise<Cart>;
	updateItem(lineId: string, quantity: number): Promise<Cart>;
	removeItem(lineId: string): Promise<Cart>;
	clear(): Promise<Cart>;
	applyCoupon(code: string): Promise<Cart>;
	removeCoupon(): Promise<Cart>;
	checkout(opts?: { email?: string }): Promise<CheckoutStart>;
	redirectToCheckout(opts?: { email?: string }): Promise<CheckoutStart>;
	getOrder(id: string, orderKey: string): Promise<PublicOrder>;
	waitForPayment(
		id: string,
		orderKey: string,
		opts?: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
	): Promise<PublicOrder>;
}

export declare function createClient(options?: ClientOptions): DashCommerceClient;
export declare function orderFromQuery(search?: string): { id: string; orderKey: string } | null;
export declare function formatMoney(value: Money, locale?: string): string;

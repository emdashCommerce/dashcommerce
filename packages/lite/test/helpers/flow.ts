/** Shared steps for unit tests: add to cart, check out, deliver webhooks. */

import { CART_HEADER } from "../../src/cart";
import { addItemHandler } from "../../src/cart-routes";
import { createCheckoutHandler } from "../../src/checkout";
import { handleStripeWebhook } from "../../src/webhook";
import { type HttpCall, type makeCtx, stripeSignature } from "./fake-ctx";

export const SK = "sk_test_1234567890abcdef";
export const WH = "whsec_testsecret123456";

let sessionSeq = 0;
export function okStripe(call: HttpCall) {
	if (call.url.endsWith("/checkout/sessions")) {
		sessionSeq += 1;
		return {
			status: 200,
			body: {
				id: `cs_test_${sessionSeq}`,
				object: "checkout.session",
				url: `https://checkout.stripe.com/c/pay/cs_test_${sessionSeq}`,
			},
		};
	}
	return { status: 404, body: { error: { message: "not found" } } };
}

export type T = ReturnType<typeof makeCtx>;

export async function addToCart(t: T, lines: Array<[string, number]>, token?: string) {
	let current = token;
	for (const [productId, quantity] of lines) {
		const res = (await addItemHandler(t.ctx, current ? { [CART_HEADER]: current } : {}, {
			productId,
			quantity,
		})) as { ok: boolean; token: string; error?: { code: string } };
		if (!res.ok) throw new Error(`add ${productId} failed: ${res.error?.code}`);
		current = res.token;
	}
	return current as string;
}

export async function checkout(t: T, token: string, body: Record<string, unknown> = {}) {
	const res = (await createCheckoutHandler(t.ctx, { [CART_HEADER]: token }, body)) as {
		ok: boolean;
		orderId: string;
		orderKey: string;
		error?: { code: string };
	};
	if (!res.ok) throw new Error(`checkout failed: ${res.error?.code}`);
	const order = (await t.orders.get(res.orderId)) as {
		stripeSessionId: string;
		total: { amount: number };
	};
	return { ...res, sessionId: order.stripeSessionId, total: order.total.amount };
}

let eventSeq = 0;
export async function deliver(t: T, type: string, object: Record<string, unknown>, id?: string) {
	eventSeq += 1;
	const payload = JSON.stringify({ id: id ?? `evt_${eventSeq}`, type, data: { object } });
	const now = Date.now();
	const sig = await stripeSignature(payload, WH, Math.floor(now / 1000));
	return handleStripeWebhook(t.ctx, payload, { "stripe-signature": sig }, now);
}

export async function pay(
	t: T,
	co: { orderId: string; sessionId: string; total: number },
	extra: Record<string, unknown> = {},
) {
	return deliver(t, "checkout.session.completed", {
		id: co.sessionId,
		object: "checkout.session",
		client_reference_id: co.orderId,
		metadata: { orderId: co.orderId },
		payment_status: "paid",
		amount_total: co.total,
		currency: "usd",
		payment_intent: `pi_${co.orderId}`,
		livemode: false,
		customer_details: { email: "Buyer@Example.com" },
		...extra,
	});
}

export async function refund(
	t: T,
	orderId: string,
	amount: number,
	refunded: number,
	opts: { metadata?: boolean; id?: string } = {},
) {
	return deliver(
		t,
		"charge.refunded",
		{
			id: `ch_${orderId}`,
			object: "charge",
			amount,
			amount_refunded: refunded,
			currency: "usd",
			payment_intent: `pi_${orderId}`,
			refunded: refunded >= amount,
			...(opts.metadata === false ? {} : { metadata: { orderId } }),
		},
		opts.id,
	);
}

/**
 * Run due one-shot `stock-*` settle tasks the way EmDash's cron executor
 * does: each task is its own invocation, a task is deleted after it runs
 * (even if it re-scheduled itself under the same name), and a task that
 * throws stays for a retry. Returns the bridge calls of each invocation.
 */
export async function runSettleTasks(t: T, maxRounds = 50): Promise<number[]> {
	const { handleCron } = await import("../../src/cron");
	const counts: number[] = [];
	for (let round = 0; round < maxRounds; round += 1) {
		const due = [...t.cronTasks.entries()].filter(([name]) => name.startsWith("stock-"));
		if (due.length === 0) break;
		for (const [name, task] of due) {
			const before = t.calls.count;
			let failed = false;
			try {
				await handleCron(
					{ name, data: task.data, scheduledAt: task.schedule } as Parameters<typeof handleCron>[0],
					t.ctx,
				);
			} catch {
				failed = true;
			}
			counts.push(t.calls.count - before);
			if (!failed) t.cronTasks.delete(name);
		}
	}
	return counts;
}

/** Bridge calls made by one invocation. */
export async function countCalls<R>(
	t: T,
	fn: () => Promise<R>,
): Promise<{ calls: number; result: R }> {
	const before = t.calls.count;
	const result = await fn();
	return { calls: t.calls.count - before, result };
}

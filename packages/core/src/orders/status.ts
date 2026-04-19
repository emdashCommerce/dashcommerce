/**
 * Order state machine helpers — pure, no I/O.
 *
 * Statuses:
 *   pending → processing → completed
 *                       → on-hold → processing | cancelled
 *                       → cancelled
 *                       → refunded | partially-refunded
 *                       → failed
 *
 * `paymentStatus` mirrors the Stripe PI side of things and moves somewhat
 * independently — an order can be `processing` + `paid` waiting for manual
 * fulfillment, then `completed` + `paid` once shipped.
 */

import type { OrderStatus, PaymentStatus } from "../types";

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
	"completed",
	"cancelled",
	"refunded",
	"failed",
]);

/** Legal forward transitions for merchant admin actions. */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
	pending: ["processing", "on-hold", "cancelled", "failed"],
	processing: ["completed", "on-hold", "cancelled", "refunded", "partially-refunded"],
	"on-hold": ["processing", "cancelled"],
	completed: ["refunded", "partially-refunded"],
	cancelled: [],
	refunded: [],
	"partially-refunded": ["refunded", "completed"],
	failed: ["pending", "cancelled"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
	if (from === to) return true;
	return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export class InvalidOrderTransitionError extends Error {
	constructor(from: OrderStatus, to: OrderStatus) {
		super(`Illegal order transition: ${from} → ${to}`);
		this.name = "InvalidOrderTransitionError";
	}
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
	if (!canTransition(from, to)) throw new InvalidOrderTransitionError(from, to);
}

export function isTerminal(status: OrderStatus): boolean {
	return TERMINAL_ORDER_STATUSES.has(status);
}

/**
 * Given refunded + paid totals, derive the paymentStatus. Used by refund
 * flow and by webhook-driven updates.
 */
export function derivePaymentStatus(
	paidMinorUnits: number,
	refundedMinorUnits: number,
): PaymentStatus {
	if (paidMinorUnits === 0) return "pending";
	if (refundedMinorUnits === 0) return "paid";
	if (refundedMinorUnits >= paidMinorUnits) return "refunded";
	return "partially-refunded";
}

export function deriveOrderStatusFromRefunds(
	currentStatus: OrderStatus,
	paidMinorUnits: number,
	refundedMinorUnits: number,
): OrderStatus {
	if (refundedMinorUnits <= 0) return currentStatus;
	if (refundedMinorUnits >= paidMinorUnits) return "refunded";
	// Partial refund — preserve completed; otherwise mark partially-refunded.
	if (currentStatus === "completed") return "partially-refunded";
	return "partially-refunded";
}

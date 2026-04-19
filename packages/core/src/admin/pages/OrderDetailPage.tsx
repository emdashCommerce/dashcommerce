/**
 * Order detail — status transitions, refunds, and full line-item history.
 *
 * Destructive/financial actions go through `confirm()` so cashier mistakes
 * don't immediately fire refunds. All write paths produce `toast`
 * notifications and are gated by a per-action pending state so rapid
 * double-clicks don't submit twice.
 */

import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	FormField,
	Input,
	Loading,
	NumberInput,
	Table,
	Toggle,
	confirm,
	toast,
	usePluginAPI,
} from "../kit";
import { MoneyDisplay } from "../ui/MoneyDisplay";
import { StatusBadge } from "../ui/StatusBadge";
import { EmptyState } from "../ui/EmptyState";
import type { Order, OrderItem, OrderStatus, Refund } from "../../types";

// Allowed forward transitions mirrored from `../../orders/status.ts` so the
// UI can hide impossible targets without round-tripping to the server.
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
	pending: ["processing", "on-hold", "cancelled", "failed"],
	processing: [
		"completed",
		"on-hold",
		"cancelled",
		"refunded",
		"partially-refunded",
	],
	"on-hold": ["processing", "cancelled"],
	completed: ["refunded", "partially-refunded"],
	cancelled: [],
	refunded: [],
	"partially-refunded": ["refunded", "completed"],
	failed: ["pending", "cancelled"],
};

const DESTRUCTIVE_STATUSES: ReadonlySet<OrderStatus> = new Set([
	"cancelled",
	"refunded",
	"failed",
]);

const STATUS_LABEL: Record<OrderStatus, string> = {
	pending: "Pending",
	processing: "Processing",
	"on-hold": "On hold",
	completed: "Completed",
	cancelled: "Cancelled",
	refunded: "Refunded",
	"partially-refunded": "Partially refunded",
	failed: "Failed",
};

function currentOrderId(): string | null {
	const hash = window.location.hash.replace(/^#/, "");
	const match = hash.match(/orders\/([^/?]+)/);
	return match?.[1] ?? null;
}

interface OrderDetail {
	order: Order;
	items: OrderItem[];
	refunds: Refund[];
}

export function OrderDetailPage() {
	const api = usePluginAPI();
	const [id, setId] = useState<string | null>(() => currentOrderId());
	const [data, setData] = useState<OrderDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		if (!id) return;
		try {
			const fresh = await api.get<OrderDetail>(`admin/orders/item?id=${encodeURIComponent(id)}`);
			setData(fresh);
			setLoadError(null);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [api, id]);

	useEffect(() => {
		const onHash = () => setId(currentOrderId());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	useEffect(() => {
		if (!id) {
			setLoading(false);
			return;
		}
		setLoading(true);
		void reload();
	}, [id, reload]);

	if (!id) {
		return <Alert type="warning" title="No order selected" />;
	}
	if (loading) return <Loading />;
	if (loadError || !data) {
		return (
			<Alert type="error" title="Could not load order">
				{loadError ?? "Not found."}
			</Alert>
		);
	}

	const { order, items, refunds } = data;

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<BackToOrdersLink />
			<OrderHeader order={order} onChanged={reload} />
			<ItemsCard items={items} />
			<RefundCard order={order} items={items} onRefunded={reload} />
			<RefundHistoryCard refunds={refunds} />
		</div>
	);
}

function BackToOrdersLink() {
	return (
		<div>
			<Button
				size="sm"
				variant="secondary"
				onClick={() => {
					// Clearing the hash lets OrdersPage re-mount the list view.
					if (window.location.hash) {
						history.replaceState(null, "", window.location.pathname + window.location.search);
						window.dispatchEvent(new HashChangeEvent("hashchange"));
					}
				}}
			>
				← Back to orders
			</Button>
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Header + status transitions
// ────────────────────────────────────────────────────────────────────────────

function OrderHeader({
	order,
	onChanged,
}: {
	order: Order;
	onChanged: () => Promise<void> | void;
}) {
	const api = usePluginAPI();
	const [pending, setPending] = useState<OrderStatus | null>(null);

	const targets = ALLOWED_TRANSITIONS[order.status] ?? [];

	async function transition(next: OrderStatus): Promise<void> {
		if (DESTRUCTIVE_STATUSES.has(next)) {
			const ok = await confirm({
				title: `Mark order ${order.orderNumber} as ${STATUS_LABEL[next].toLowerCase()}?`,
				description:
					next === "cancelled"
						? "Cancelling a paid order does not refund the customer. Issue a refund separately if required."
						: next === "refunded"
							? "This only updates the order status. Use the refund panel below to actually return funds."
							: "Marking failed is final for the customer facing status.",
				confirmLabel: STATUS_LABEL[next],
				destructive: true,
			});
			if (!ok) return;
		}
		setPending(next);
		try {
			await api.post(`admin/orders/status?id=${encodeURIComponent(order.id)}`, { status: next });
			toast.success(`Order moved to ${STATUS_LABEL[next].toLowerCase()}`);
			await onChanged();
		} catch (err) {
			toast.error(
				"Could not update order",
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			setPending(null);
		}
	}

	const rowStyle: CSSProperties = {
		display: "flex",
		flexWrap: "wrap",
		gap: 12,
		alignItems: "center",
	};

	return (
		<Card title={`Order ${order.orderNumber}`}>
			<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<div style={rowStyle}>
					<StatusBadge status={order.status} />
					<StatusBadge status={order.paymentStatus} />
					<span style={{ color: "#6b7280", fontSize: 13 }}>
						Placed {new Date(order.createdAt).toLocaleString()}
					</span>
				</div>
				<div style={rowStyle}>
					<span>
						<strong>Customer:</strong> {order.customerEmail}
					</span>
					<span>
						<strong>Total:</strong> <MoneyDisplay value={order.total} />
					</span>
					<span>
						<strong>Paid:</strong> <MoneyDisplay value={order.paidTotal} />
					</span>
					<span>
						<strong>Refunded:</strong>{" "}
						<MoneyDisplay value={order.refundedTotal} />
					</span>
				</div>
				<div style={{ fontSize: 13, color: "#374151" }}>
					<strong>Ship to:</strong>{" "}
					{`${order.shippingAddress.line1}, ${order.shippingAddress.city}, ${order.shippingAddress.country}`}
				</div>
				{targets.length > 0 && (
					<div style={{ ...rowStyle, marginTop: 4 }}>
						<span style={{ fontSize: 13, color: "#374151" }}>Move to:</span>
						{targets.map((t) => (
							<Button
								key={t}
								size="sm"
								variant={DESTRUCTIVE_STATUSES.has(t) ? "danger" : "secondary"}
								disabled={pending !== null}
								onClick={() => transition(t)}
							>
								{pending === t ? "Working…" : STATUS_LABEL[t]}
							</Button>
						))}
					</div>
				)}
			</div>
		</Card>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Items
// ────────────────────────────────────────────────────────────────────────────

function ItemsCard({ items }: { items: OrderItem[] }) {
	return (
		<Card title="Items">
			{items.length === 0 ? (
				<EmptyState title="No items on this order" />
			) : (
				<Table<OrderItem>
					data={items}
					getRowKey={(i) => i.id}
					columns={[
						{
							key: "name",
							header: "Item",
							render: (i) => (
								<>
									<div>{i.name}</div>
									<div style={{ fontSize: 12, color: "#6b7280" }}>
										SKU {i.sku || "—"}
									</div>
								</>
							),
						},
						{
							key: "qty",
							header: "Qty",
							render: (i) => i.quantity,
						},
						{
							key: "unit",
							header: "Unit",
							render: (i) => <MoneyDisplay value={i.unitPrice} />,
						},
						{
							key: "total",
							header: "Total",
							render: (i) => <MoneyDisplay value={i.total} />,
						},
					]}
				/>
			)}
		</Card>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Refund panel
// ────────────────────────────────────────────────────────────────────────────

function RefundCard({
	order,
	items,
	onRefunded,
}: {
	order: Order;
	items: OrderItem[];
	onRefunded: () => Promise<void> | void;
}) {
	const api = usePluginAPI();
	const remainingMinor = order.paidTotal.amount - order.refundedTotal.amount;
	const remainingMajor = remainingMinor / 100;

	const [amountMajor, setAmountMajor] = useState<number | undefined>(undefined);
	const [reason, setReason] = useState("");
	const [restock, setRestock] = useState(false);
	const [pending, setPending] = useState(false);

	const fullRefund = useMemo(() => {
		return typeof amountMajor === "number" && amountMajor >= remainingMajor;
	}, [amountMajor, remainingMajor]);

	async function issueRefund(): Promise<void> {
		if (pending) return;
		const amt = typeof amountMajor === "number" ? Math.round(amountMajor * 100) : 0;
		if (!Number.isFinite(amt) || amt <= 0) {
			toast.error("Enter a positive refund amount");
			return;
		}
		if (amt > remainingMinor) {
			toast.error(
				"Refund exceeds refundable balance",
				"Reduce the amount to the remaining balance.",
			);
			return;
		}
		const ok = await confirm({
			title: fullRefund ? "Refund the remaining balance?" : "Issue partial refund?",
			description: fullRefund
				? "Stripe will return the remaining balance to the customer immediately. This cannot be undone."
				: "Stripe will return the specified amount to the customer. This cannot be undone.",
			confirmLabel: "Issue refund",
			destructive: true,
		});
		if (!ok) return;

		setPending(true);
		try {
			await api.post(`admin/orders/refund?id=${encodeURIComponent(order.id)}`, {
				amount: amt,
				currency: order.currency,
				reason: reason || undefined,
				restock: restock || undefined,
			});
			toast.success(
				fullRefund ? "Full refund issued" : "Refund issued",
				`${(amt / 100).toFixed(2)} ${order.currency} returned to customer.`,
			);
			setAmountMajor(undefined);
			setReason("");
			setRestock(false);
			await onRefunded();
		} catch (err) {
			toast.error(
				"Refund failed",
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<Card title="Issue refund">
			{remainingMinor <= 0 ? (
				<Alert type="info" title="No refundable balance">
					This order has already been fully refunded or never captured
					payment.
				</Alert>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
					<div style={{ fontSize: 13, color: "#374151" }}>
						Up to <MoneyDisplay value={{ ...order.paidTotal, amount: remainingMinor }} /> can
						still be refunded.
					</div>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1fr 1fr",
							gap: 12,
						}}
					>
						<FormField label={`Amount (${order.currency})`} required>
							<NumberInput
								value={amountMajor}
								onChange={setAmountMajor}
								min={0}
								max={remainingMajor}
								step={0.01}
								placeholder={remainingMajor.toFixed(2)}
								disabled={pending}
							/>
						</FormField>
						<FormField label="Reason" description="Optional, shown in refund history.">
							<Input
								value={reason}
								onChange={(e) => setReason(e.currentTarget.value)}
								placeholder="e.g. Damaged on arrival"
								disabled={pending}
							/>
						</FormField>
					</div>
					{items.some((i) => !i.isDigital) && (
						<Toggle
							label="Restock items"
							checked={restock}
							onChange={setRestock}
							disabled={pending}
						/>
					)}
					<div style={{ display: "flex", gap: 8 }}>
						<Button
							variant="danger"
							disabled={pending || !amountMajor}
							onClick={issueRefund}
						>
							{pending ? "Refunding…" : "Issue refund"}
						</Button>
						<Button
							variant="secondary"
							disabled={pending}
							onClick={() => setAmountMajor(remainingMajor)}
						>
							Fill remaining balance
						</Button>
					</div>
				</div>
			)}
		</Card>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Refund history
// ────────────────────────────────────────────────────────────────────────────

function RefundHistoryCard({ refunds }: { refunds: Refund[] }) {
	return (
		<Card title="Refund history">
			{refunds.length === 0 ? (
				<EmptyState title="No refunds issued yet" />
			) : (
				<Table<Refund>
					data={refunds}
					getRowKey={(r) => r.id}
					columns={[
						{
							key: "amt",
							header: "Amount",
							render: (r) => <MoneyDisplay value={r.amount} />,
						},
						{
							key: "reason",
							header: "Reason",
							render: (r) => r.reason ?? "—",
						},
						{
							key: "status",
							header: "Status",
							render: (r) => <StatusBadge status={r.status} />,
						},
						{
							key: "when",
							header: "When",
							render: (r) => new Date(r.createdAt).toLocaleString(),
						},
					]}
				/>
			)}
		</Card>
	);
}

/**
 * Orders list — server-side filter + pagination via `useListControls`.
 *
 * Filters:
 *   - order status (indexed)
 *   - payment status (indexed)
 *   - customer email (post-fetch substring match)
 *   - total range in minor units (post-fetch predicate)
 *   - created date range (indexed range filter)
 *
 * Cursor-based pagination: "Load more" appends the next page without
 * dropping what's already rendered so operators can keep scrolling
 * during triage.
 */

import { useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	FormField,
	Input,
	Loading,
	NumberInput,
	Select,
	Table,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import { MoneyDisplay } from "../ui/MoneyDisplay";
import { StatusBadge } from "../ui/StatusBadge";
import type { Order, OrderStatus, PaymentStatus } from "../../types";
import { useListControls } from "../hooks/useListControls";
import { OrderDetailPage } from "./OrderDetailPage";

// The emdash admin shell resolves plugin pages by *exact* path match on the
// entry's `pages` map, so a parametric key like `/orders/:id` never mounts.
// We instead use a hash fragment (`#/orders/<id>`) to open the detail view
// inline over the list.
function orderIdFromHash(): string | null {
	const match = window.location.hash.match(/orders\/([^/?]+)/);
	return match?.[1] ?? null;
}

interface OrdersFilters {
	status: OrderStatus | "";
	paymentStatus: PaymentStatus | "";
	email: string;
	minTotalMajor: number | undefined;
	maxTotalMajor: number | undefined;
	from: string;
	to: string;
}

const ORDER_STATUS_OPTIONS: { value: OrdersFilters["status"]; label: string }[] = [
	{ value: "", label: "Any status" },
	{ value: "pending", label: "Pending" },
	{ value: "processing", label: "Processing" },
	{ value: "on-hold", label: "On hold" },
	{ value: "completed", label: "Completed" },
	{ value: "cancelled", label: "Cancelled" },
	{ value: "refunded", label: "Refunded" },
	{ value: "partially-refunded", label: "Partially refunded" },
	{ value: "failed", label: "Failed" },
];

const PAYMENT_STATUS_OPTIONS: {
	value: OrdersFilters["paymentStatus"];
	label: string;
}[] = [
	{ value: "", label: "Any payment" },
	{ value: "pending", label: "Pending" },
	{ value: "paid", label: "Paid" },
	{ value: "failed", label: "Failed" },
	{ value: "refunded", label: "Refunded" },
	{ value: "partially-refunded", label: "Partially refunded" },
];

const INITIAL: OrdersFilters = {
	status: "",
	paymentStatus: "",
	email: "",
	minTotalMajor: undefined,
	maxTotalMajor: undefined,
	from: "",
	to: "",
};

export function OrdersPage() {
	const [detailId, setDetailId] = useState<string | null>(() => orderIdFromHash());

	useEffect(() => {
		const onHash = () => setDetailId(orderIdFromHash());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	return detailId ? <OrderDetailPage /> : <OrdersList />;
}

function OrdersList() {
	const api = usePluginAPI();

	const buildQuery = useMemo(
		() => (f: OrdersFilters) => ({
			status: f.status || undefined,
			paymentStatus: f.paymentStatus || undefined,
			email: f.email.trim() || undefined,
			minTotal:
				typeof f.minTotalMajor === "number"
					? Math.round(f.minTotalMajor * 100)
					: undefined,
			maxTotal:
				typeof f.maxTotalMajor === "number"
					? Math.round(f.maxTotalMajor * 100)
					: undefined,
			from: f.from || undefined,
			to: f.to || undefined,
		}),
		[],
	);

	const controls = useListControls<OrdersFilters, Order>({
		api,
		endpoint: "admin/orders",
		initialFilters: INITIAL,
		buildQuery,
		limit: 50,
	});

	const { filters, setFilter, resetFilters, items, loading, error, hasMore, loadMore } =
		controls;

	const activeFilterCount = [
		filters.status,
		filters.paymentStatus,
		filters.email.trim(),
		filters.minTotalMajor,
		filters.maxTotalMajor,
		filters.from,
		filters.to,
	].filter((v) => v !== "" && v !== undefined && v !== null).length;

	return (
		<Card title="Orders">
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
					gap: 12,
					marginBottom: 12,
				}}
			>
				<Select
					label="Order status"
					value={filters.status}
					options={ORDER_STATUS_OPTIONS}
					onChange={(e) =>
						setFilter("status", e.currentTarget.value as OrderStatus | "")
					}
				/>
				<Select
					label="Payment status"
					value={filters.paymentStatus}
					options={PAYMENT_STATUS_OPTIONS}
					onChange={(e) =>
						setFilter(
							"paymentStatus",
							e.currentTarget.value as PaymentStatus | "",
						)
					}
				/>
				<Input
					label="Customer email"
					value={filters.email}
					onChange={(e) => setFilter("email", e.currentTarget.value)}
					placeholder="e.g. alice@"
				/>
				<FormField label="Total min">
					<NumberInput
						value={filters.minTotalMajor}
						onChange={(v) => setFilter("minTotalMajor", v)}
						min={0}
						step={0.01}
						placeholder="0.00"
					/>
				</FormField>
				<FormField label="Total max">
					<NumberInput
						value={filters.maxTotalMajor}
						onChange={(v) => setFilter("maxTotalMajor", v)}
						min={0}
						step={0.01}
						placeholder="∞"
					/>
				</FormField>
				<Input
					label="From"
					type="date"
					value={filters.from}
					onChange={(e) => setFilter("from", e.currentTarget.value)}
				/>
				<Input
					label="To"
					type="date"
					value={filters.to}
					onChange={(e) => setFilter("to", e.currentTarget.value)}
				/>
			</div>
			{activeFilterCount > 0 && (
				<div
					style={{
						display: "flex",
						gap: 8,
						alignItems: "center",
						marginBottom: 12,
					}}
				>
					<span style={{ color: "#6b7280", fontSize: 13 }}>
						{activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} applied
					</span>
					<Button size="sm" variant="secondary" onClick={resetFilters}>
						Clear
					</Button>
				</div>
			)}

			{error && (
				<Alert type="error" title="Could not load orders">
					{error}
				</Alert>
			)}

			{items.length === 0 && !loading ? (
				<EmptyState
					title={
						activeFilterCount > 0 ? "No orders match" : "No orders yet"
					}
					description={
						activeFilterCount > 0
							? "Try widening your filters."
							: "Orders will appear here after your first checkout."
					}
				/>
			) : (
				<>
					<Table<Order>
						data={items}
						getRowKey={(o) => o.id}
						onRowClick={(o) => {
							window.location.hash = `/orders/${o.id}`;
						}}
						columns={[
							{ key: "num", header: "Order", render: (o) => o.orderNumber },
							{
								key: "status",
								header: "Status",
								render: (o) => (
									<div
										style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
									>
										<StatusBadge status={o.status} />
										<StatusBadge status={o.paymentStatus} />
									</div>
								),
							},
							{
								key: "email",
								header: "Customer",
								render: (o) => o.customerEmail,
							},
							{
								key: "total",
								header: "Total",
								render: (o) => <MoneyDisplay value={o.total} />,
							},
							{
								key: "date",
								header: "Placed",
								render: (o) => new Date(o.createdAt).toLocaleString(),
							},
						]}
					/>
					<div
						style={{
							display: "flex",
							justifyContent: "center",
							padding: 12,
						}}
					>
						{loading ? (
							<Loading label="Loading…" />
						) : hasMore ? (
							<Button variant="secondary" onClick={loadMore}>
								Load more
							</Button>
						) : items.length > 0 ? (
							<span style={{ color: "#6b7280", fontSize: 13 }}>
								End of results — {items.length} orders
							</span>
						) : null}
					</div>
				</>
			)}
		</Card>
	);
}

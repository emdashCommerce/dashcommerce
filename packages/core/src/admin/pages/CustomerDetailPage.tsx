import { useEffect, useState } from "react";
import { Button, Card, Loading, MoneyMinor, Table, usePluginAPI } from "../kit";
import { MoneyDisplay } from "../ui/MoneyDisplay";
import { StatusBadge } from "../ui/StatusBadge";
import type { Customer, Order, Subscription } from "../../types";

function currentCustomerId(): string | null {
	const match = window.location.hash.match(/customers\/([^/?]+)/);
	return match?.[1] ?? null;
}

interface Detail {
	customer: Customer;
	orders: Order[];
	subscriptions: Subscription[];
}

export function CustomerDetailPage() {
	const api = usePluginAPI();
	const [id, setId] = useState<string | null>(() => currentCustomerId());
	const [data, setData] = useState<Detail | null>(null);

	useEffect(() => {
		const onHash = () => setId(currentCustomerId());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	useEffect(() => {
		if (!id) return;
		api.get<Detail>(`admin/customers/item?id=${encodeURIComponent(id)}`).then(setData);
	}, [api, id]);

	if (!id || !data) return <Loading />;
	const { customer, orders, subscriptions } = data;

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<div>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => {
						if (window.location.hash) {
							history.replaceState(
								null,
								"",
								window.location.pathname + window.location.search,
							);
							window.dispatchEvent(new HashChangeEvent("hashchange"));
						}
					}}
				>
					← Back to customers
				</Button>
			</div>
			<Card title={customer.email}>
				<p>
					<strong>Name:</strong>{" "}
					{`${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "—"}
				</p>
				<p>
					<strong>Orders:</strong> {customer.ordersCount}
				</p>
				<div
					style={{
						display: "flex",
						gap: 8,
						alignItems: "center",
						flexWrap: "wrap",
					}}
				>
					<strong>Lifetime:</strong>
					{Object.entries(customer.totalSpent ?? {}).length === 0 ? (
						<span>—</span>
					) : (
						Object.entries(customer.totalSpent ?? {}).map(([cc, amt]) => (
							<MoneyMinor key={cc} amount={amt as number} currency={cc} />
						))
					)}
				</div>
			</Card>

			<Card title="Orders">
				<Table<Order>
					data={orders}
					getRowKey={(o) => o.id}
					emptyMessage="No orders yet"
					onRowClick={(o) => {
						window.location.hash = `/orders/${o.id}`;
					}}
					columns={[
						{ key: "num", header: "Order", render: (o) => o.orderNumber },
						{
							key: "status",
							header: "Status",
							render: (o) => <StatusBadge status={o.status} />,
						},
						{ key: "total", header: "Total", render: (o) => <MoneyDisplay value={o.total} /> },
						{ key: "when", header: "When", render: (o) => new Date(o.createdAt).toLocaleDateString() },
					]}
				/>
			</Card>

			<Card title="Subscriptions">
				<Table<Subscription>
					data={subscriptions}
					getRowKey={(s) => s.id}
					emptyMessage="No subscriptions"
					columns={[
						{
							key: "status",
							header: "Status",
							render: (s) => <StatusBadge status={s.status} />,
						},
						{
							key: "amt",
							header: "Price",
							render: (s) => (
								<>
									<MoneyDisplay value={s.unitAmount} /> / {s.intervalCount} {s.interval}
								</>
							),
						},
						{
							key: "next",
							header: "Next billed",
							render: (s) => new Date(s.currentPeriodEnd).toLocaleDateString(),
						},
					]}
				/>
			</Card>
		</div>
	);
}

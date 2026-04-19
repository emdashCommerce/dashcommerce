import { useEffect, useState } from "react";
import { Loading, usePluginAPI } from "../kit";
import { MoneyDisplay } from "../ui/MoneyDisplay";
import { StatusBadge } from "../ui/StatusBadge";
import type { Money } from "../../types";

interface Row {
	id: string;
	orderNumber: string;
	status: string;
	total: Money;
	customerEmail: string;
	createdAt: string;
}

export function RecentOrders() {
	const api = usePluginAPI();
	const [rows, setRows] = useState<Row[] | null>(null);

	useEffect(() => {
		api.get<{ items: Row[] }>("admin/widgets/recent-orders").then((r) =>
			setRows(r.items),
		);
	}, [api]);

	if (rows === null) return <Loading />;
	if (rows.length === 0) return <p style={{ margin: 0 }}>No orders yet.</p>;

	return (
		<ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
			{rows.map((r) => (
				<li
					key={r.id}
					style={{
						display: "grid",
						gridTemplateColumns: "auto auto 1fr auto",
						gap: 8,
						padding: "4px 0",
						borderBottom: "1px solid #eee",
						alignItems: "baseline",
					}}
				>
					<a href={`#/orders/${r.id}`}>{r.orderNumber}</a>
					<StatusBadge status={r.status} />
					<span style={{ color: "#666" }}>{r.customerEmail}</span>
					<span>
						<MoneyDisplay value={r.total} />
					</span>
				</li>
			))}
		</ul>
	);
}

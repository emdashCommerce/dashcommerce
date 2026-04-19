import { useEffect, useState } from "react";
import { Loading, usePluginAPI } from "../kit";

interface Row {
	productId: string;
	title: string;
	stockQuantity: number | null;
	lowStockThreshold: number | null;
	belowThresholdAt: string | null;
}

export function LowStockAlerts() {
	const api = usePluginAPI();
	const [rows, setRows] = useState<Row[] | null>(null);

	useEffect(() => {
		api.get<{ items: Row[] }>("admin/widgets/low-stock-alerts").then((r) =>
			setRows(r.items),
		);
	}, [api]);

	if (rows === null) return <Loading />;
	if (rows.length === 0) return <p style={{ margin: 0 }}>All products above threshold ✓</p>;

	return (
		<ul style={{ margin: 0, paddingLeft: 18 }}>
			{rows.map((r) => (
				<li key={r.productId}>
					{r.title} — {r.stockQuantity ?? "?"} left
				</li>
			))}
		</ul>
	);
}

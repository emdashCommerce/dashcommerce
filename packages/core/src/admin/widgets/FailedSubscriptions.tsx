import { useEffect, useState } from "react";
import { Loading, usePluginAPI } from "../kit";
import { MoneyDisplay } from "../ui/MoneyDisplay";
import type { Subscription } from "../../types";

interface Shape {
	count: number;
	items: Subscription[];
}

export function FailedSubscriptions() {
	const api = usePluginAPI();
	const [data, setData] = useState<Shape | null>(null);

	useEffect(() => {
		api.get<Shape>("admin/widgets/failed-subscriptions").then(setData);
	}, [api]);

	if (!data) return <Loading />;

	if (data.count === 0) {
		return <p style={{ margin: 0 }}>All subscriptions current ✓</p>;
	}

	return (
		<div>
			<div style={{ fontWeight: 700, color: "#a00", marginBottom: 4 }}>
				{data.count} past-due
			</div>
			<ul style={{ margin: 0, paddingLeft: 18 }}>
				{data.items.map((s) => (
					<li key={s.id}>
						<MoneyDisplay value={s.unitAmount} /> / {s.intervalCount}{" "}
						{s.interval}
					</li>
				))}
			</ul>
		</div>
	);
}

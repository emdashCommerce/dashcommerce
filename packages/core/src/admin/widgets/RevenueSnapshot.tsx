import { useEffect, useState } from "react";
import { Loading, usePluginAPI } from "../kit";

interface Shape {
	sevenDay: Record<string, number>;
	thirtyDay: Record<string, number>;
}

export function RevenueSnapshot() {
	const api = usePluginAPI();
	const [data, setData] = useState<Shape | null>(null);

	useEffect(() => {
		api.get<Shape>("admin/widgets/revenue-snapshot").then(setData);
	}, [api]);

	if (!data) return <Loading />;

	return (
		<div>
			<div style={{ display: "flex", gap: 24 }}>
				<div>
					<div style={{ fontSize: "0.8em", color: "#666" }}>Last 7 days</div>
					<div style={{ fontSize: "1.4em", fontWeight: 700 }}>
						{Object.entries(data.sevenDay).length === 0
							? "—"
							: Object.entries(data.sevenDay)
									.map(([c, v]) => `${c} ${(v as number) / 100}`)
									.join(" · ")}
					</div>
				</div>
				<div>
					<div style={{ fontSize: "0.8em", color: "#666" }}>Last 30 days</div>
					<div style={{ fontSize: "1.4em", fontWeight: 700 }}>
						{Object.entries(data.thirtyDay).length === 0
							? "—"
							: Object.entries(data.thirtyDay)
									.map(([c, v]) => `${c} ${(v as number) / 100}`)
									.join(" · ")}
					</div>
				</div>
			</div>
		</div>
	);
}

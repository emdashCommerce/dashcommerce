import { useEffect, useState } from "react";
import { Loading, usePluginAPI } from "../kit";

export function PendingReviews() {
	const api = usePluginAPI();
	const [count, setCount] = useState<number | null>(null);

	useEffect(() => {
		api
			.get<{ count: number }>("admin/widgets/pending-reviews")
			.then((r) => setCount(r.count));
	}, [api]);

	if (count === null) return <Loading />;
	return (
		<a href="#/reviews" style={{ display: "block" }}>
			<div style={{ fontSize: "2em", fontWeight: 700 }}>{count}</div>
			<div style={{ color: "#666" }}>Pending review{count === 1 ? "" : "s"}</div>
		</a>
	);
}

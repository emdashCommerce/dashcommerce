import type { ReactNode } from "react";

export function EmptyState({
	title,
	description,
	action,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div
			style={{
				textAlign: "center",
				padding: "3rem 1rem",
				color: "#666",
			}}
		>
			<h3 style={{ margin: 0, color: "#333" }}>{title}</h3>
			{description && <p>{description}</p>}
			{action && <div style={{ marginTop: 16 }}>{action}</div>}
		</div>
	);
}

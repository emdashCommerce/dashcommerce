import type { ReactNode } from "react";
import { adminColors } from "../theme";

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
				color: adminColors.subtle,
			}}
		>
			<h3 style={{ margin: 0, color: adminColors.text }}>{title}</h3>
			{description && <p>{description}</p>}
			{action && <div style={{ marginTop: 16 }}>{action}</div>}
		</div>
	);
}

import type { ReactNode } from "react";
import { T } from "../theme";

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
				color: T.textMuted,
			}}
		>
			<h3 style={{ margin: 0, color: T.textStrong }}>{title}</h3>
			{description && <p>{description}</p>}
			{action && <div style={{ marginTop: 16 }}>{action}</div>}
		</div>
	);
}

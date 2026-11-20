import { STATUS_FILL, STATUS_FILL_DEFAULT, T } from "../theme";

export function StatusBadge({ status }: { status: string }) {
	const color = STATUS_FILL[status] ?? STATUS_FILL_DEFAULT;
	return (
		<span
			style={{
				background: color,
				color: T.onFill,
				borderRadius: 4,
				padding: "2px 8px",
				fontSize: "0.8em",
				textTransform: "uppercase",
				letterSpacing: 0.5,
			}}
		>
			{status}
		</span>
	);
}

const COLORS: Record<string, string> = {
	pending: "#8c7b00",
	processing: "#0066cc",
	"on-hold": "#8b5a2b",
	completed: "#2d7a3a",
	cancelled: "#7a2d2d",
	refunded: "#555",
	"partially-refunded": "#776",
	failed: "#a00",
	paid: "#2d7a3a",
	active: "#2d7a3a",
	trialing: "#0066cc",
	past_due: "#a00",
	canceled: "#555",
	approved: "#2d7a3a",
	rejected: "#a00",
	spam: "#555",
};

export function StatusBadge({ status }: { status: string }) {
	const color = COLORS[status] ?? "#555";
	return (
		<span
			style={{
				background: color,
				color: "#fff",
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

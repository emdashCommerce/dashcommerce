import { adminColors } from "../theme";

const STATUS_STYLES: Record<string, { background: string; color: string }> = {
	pending: {
		background: "light-dark(#fef3c7, #422006)",
		color: "light-dark(#92400e, #fde68a)",
	},
	processing: {
		background: "var(--color-kumo-tint, light-dark(#dbeafe, #172554))",
		color: "var(--color-kumo-brand, light-dark(#1d4ed8, #bfdbfe))",
	},
	"on-hold": {
		background: "light-dark(#ffedd5, #431407)",
		color: "light-dark(#9a3412, #fed7aa)",
	},
	completed: {
		background: "light-dark(#dcfce7, #052e16)",
		color: "light-dark(#166534, #bbf7d0)",
	},
	failed: {
		background: "light-dark(#fee2e2, #450a0a)",
		color: "light-dark(#991b1b, #fecaca)",
	},
	paid: {
		background: "light-dark(#dcfce7, #052e16)",
		color: "light-dark(#166534, #bbf7d0)",
	},
	active: {
		background: "light-dark(#dcfce7, #052e16)",
		color: "light-dark(#166534, #bbf7d0)",
	},
	trialing: {
		background: "var(--color-kumo-tint, light-dark(#dbeafe, #172554))",
		color: "var(--color-kumo-brand, light-dark(#1d4ed8, #bfdbfe))",
	},
	past_due: {
		background: "light-dark(#fee2e2, #450a0a)",
		color: "light-dark(#991b1b, #fecaca)",
	},
	approved: {
		background: "light-dark(#dcfce7, #052e16)",
		color: "light-dark(#166534, #bbf7d0)",
	},
	rejected: {
		background: "light-dark(#fee2e2, #450a0a)",
		color: "light-dark(#991b1b, #fecaca)",
	},
};

const NEUTRAL_STATUS: { background: string; color: string } = {
	background: "var(--color-kumo-fill, light-dark(#f4f4f5, #27272a))",
	color: "var(--text-color-kumo-subtle, light-dark(#52525b, #d4d4d8))",
};

export function StatusBadge({ status }: { status: string }) {
	const style = STATUS_STYLES[status] ?? NEUTRAL_STATUS;
	return (
		<span
			style={{
				background: style.background,
				color: style.color,
				borderRadius: 4,
				padding: "2px 8px",
				fontSize: "0.75rem",
				textTransform: "uppercase",
				letterSpacing: 0.5,
			}}
		>
			{status}
		</span>
	);
}

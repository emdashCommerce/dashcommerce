import type { ChangeEvent } from "react";

export interface DateRange {
	from: string; // ISO date (YYYY-MM-DD)
	to: string;
}

export function DateRangePicker({
	value,
	onChange,
}: {
	value: DateRange;
	onChange: (next: DateRange) => void;
}) {
	return (
		<span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
			<input
				type="date"
				value={value.from}
				onChange={(e: ChangeEvent<HTMLInputElement>) =>
					onChange({ ...value, from: e.target.value })
				}
			/>
			<span>→</span>
			<input
				type="date"
				value={value.to}
				onChange={(e: ChangeEvent<HTMLInputElement>) =>
					onChange({ ...value, to: e.target.value })
				}
			/>
		</span>
	);
}

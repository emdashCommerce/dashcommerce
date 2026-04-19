import { useEffect, useState } from "react";
import { usePluginAPI } from "../kit";

export function CurrencyPicker({
	value,
	onChange,
}: {
	value: string | null;
	onChange: (currency: string | null) => void;
}) {
	const api = usePluginAPI();
	const [currencies, setCurrencies] = useState<string[]>([]);

	useEffect(() => {
		(async () => {
			try {
				const settings = await api.get<Record<string, unknown>>("admin/settings");
				const enabled = settings.enabledCurrencies;
				if (Array.isArray(enabled)) setCurrencies(enabled as string[]);
			} catch {
				// Ignore — default to a minimal currency list below.
			}
		})();
	}, [api]);

	return (
		<select
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || null)}
		>
			<option value="">All currencies</option>
			{currencies.map((c) => (
				<option key={c} value={c}>
					{c}
				</option>
			))}
		</select>
	);
}

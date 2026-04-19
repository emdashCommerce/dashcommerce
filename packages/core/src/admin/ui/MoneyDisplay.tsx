import type { Money } from "../../types";
import { format } from "../../money";

export function MoneyDisplay({ value, locale }: { value: Money; locale?: string }) {
	if (!value) return <span>—</span>;
	return <span>{format(value, locale)}</span>;
}

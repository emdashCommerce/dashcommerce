/**
 * Small formatting helpers shared across email composers. Separate from
 * money.ts so email code doesn't grow a dependency on the full pricing
 * engine — composers stay quick to import and easy to tree-shake.
 */

import { format as formatMoneyBase, type Money } from "../money";
import type { Address } from "../types";

export function formatMoney(m: Money): string {
	return formatMoneyBase(m);
}

export function formatAddress(a: Address): string {
	const name = [a.firstName, a.lastName].filter(Boolean).join(" ");
	const lines = [
		name,
		a.company,
		a.line1,
		a.line2,
		[a.city, a.region, a.postalCode].filter(Boolean).join(" "),
		a.country,
	].filter((s): s is string => !!s && s.trim().length > 0);
	return lines.join("\n");
}

export function greet(firstName?: string): string {
	return firstName ? `Hi ${firstName},` : "Hi,";
}

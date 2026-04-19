/**
 * Tax — flat & table implementations.
 *
 * `flat` is a single percentage read from plugin settings.
 * `table` looks up rates by country/region/postal code match, descending
 * priority, respecting tax class.
 *
 * Stripe Tax path is invoked during Payment Intent creation in Phase 5 —
 * not here — because it consumes a PaymentIntent id.
 */

import { percent as pct, type Money } from "../money";
import type { CountryCode, TaxLine, TaxRate } from "../types";

export interface TableLookup {
	country: CountryCode;
	region?: string;
	postalCode?: string;
	taxClass: string;
}

export function selectApplicableRates(
	rates: TaxRate[],
	lookup: TableLookup,
): TaxRate[] {
	const matches = rates.filter((r) => {
		if (r.country !== lookup.country) return false;
		if (r.region && r.region !== lookup.region) return false;
		if (r.postalCode && lookup.postalCode) {
			if (!lookup.postalCode.startsWith(r.postalCode)) return false;
		}
		if (r.taxClass !== lookup.taxClass) return false;
		return true;
	});
	return matches.sort((a, b) => a.priority - b.priority);
}

export function tableTaxLines(base: Money, rates: TaxRate[]): TaxLine[] {
	const lines: TaxLine[] = [];
	let runningBase = base;
	for (const r of rates) {
		const applicable = r.compound ? runningBase : base;
		const amount = pct(applicable, r.rate);
		lines.push({ label: r.name, amount, rate: r.rate });
		if (r.compound) {
			// accumulate into base for subsequent compounds
			runningBase = { ...runningBase, amount: runningBase.amount + amount.amount };
		}
	}
	return lines;
}

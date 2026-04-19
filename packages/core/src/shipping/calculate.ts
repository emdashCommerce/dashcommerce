/**
 * Shipping rate calculator.
 *
 * Given a cart + an ordered list of zones, pick the first zone whose
 * locations match the cart's shipping address, then return the list of
 * applicable method rates.
 */

import { add, money, zero, type Money } from "../money";
import type {
	Address,
	CartLineItem,
	ShippingMethod,
	ShippingRateOption,
	ShippingZone,
} from "../types";

export function matchesZone(address: Address, zone: ShippingZone): boolean {
	for (const loc of zone.locations) {
		if (loc.country !== address.country) continue;
		if (!loc.regions || loc.regions.length === 0) return true;
		if (loc.regions.includes(address.region)) return true;
	}
	return false;
}

export function pickZone(
	address: Address,
	zones: ShippingZone[],
): ShippingZone | null {
	const sorted = [...zones].sort((a, b) => a.order - b.order);
	for (const zone of sorted) {
		if (matchesZone(address, zone)) return zone;
	}
	return null;
}

function cartSubtotal(items: CartLineItem[], currency: string): Money {
	let total = 0;
	for (const item of items) total += item.lineSubtotal.amount;
	return money(currency, total);
}

function cartWeightGrams(items: CartLineItem[]): number {
	let total = 0;
	for (const item of items) {
		const grams = item.weightGrams ?? 0;
		total += grams * item.quantity;
	}
	return total;
}

export interface CalculateRatesInput {
	items: CartLineItem[];
	currency: string;
	methods: ShippingMethod[];
	couponsGiveFreeShipping?: boolean;
}

export function calculateRates(input: CalculateRatesInput): ShippingRateOption[] {
	const subtotal = cartSubtotal(input.items, input.currency);
	const weightGrams = cartWeightGrams(input.items);
	const options: ShippingRateOption[] = [];

	for (const method of input.methods) {
		if (!method.enabled) continue;
		const cfg = method.config;

		if (input.couponsGiveFreeShipping) {
			options.push({
				methodId: method.id,
				label: method.title,
				amount: zero(input.currency),
			});
			continue;
		}

		if (cfg.type === "flat_rate") {
			options.push({
				methodId: method.id,
				label: method.title,
				amount: cfg.amount,
			});
		} else if (cfg.type === "free_shipping") {
			const min = cfg.minimumAmount;
			const qualifies = !min || subtotal.amount >= min.amount;
			if (qualifies) {
				options.push({
					methodId: method.id,
					label: method.title,
					amount: zero(input.currency),
				});
			}
		} else if (cfg.type === "local_pickup") {
			options.push({
				methodId: method.id,
				label: method.title,
				amount: cfg.amount ?? zero(input.currency),
			});
		} else if (cfg.type === "weight_based") {
			if (cfg.currency !== input.currency) continue;
			const variable = money(cfg.currency, Math.round(cfg.perGram * weightGrams));
			options.push({
				methodId: method.id,
				label: method.title,
				amount: add(cfg.base, variable),
			});
		}
	}

	return options;
}

/**
 * Normalize the admin shipping payload so a flattened EmDash envelope
 * (`{ success: true, data: {} }`) cannot crash the shipping page.
 */

import type { ShippingClass, ShippingMethod, ShippingZone } from "../types";

export interface ShippingShape {
	zones: ShippingZone[];
	methods: ShippingMethod[];
	classes: ShippingClass[];
}

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

export function normalizeShippingShape(raw: unknown): ShippingShape {
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		zones: asArray<ShippingZone>(obj.zones),
		methods: asArray<ShippingMethod>(obj.methods),
		classes: asArray<ShippingClass>(obj.classes),
	};
}

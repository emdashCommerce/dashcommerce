/**
 * VendorSelect — custom field widget for the products collection's
 * `vendor_id` field. Registered via `fieldWidgets` in the plugin
 * descriptor and exported from `admin/entry.tsx` under `fields["vendor-select"]`.
 *
 * Emdash's content editor passes at minimum `{ value, onChange }`. We keep
 * the props loosely typed so future emdash releases can hand us more
 * context (field definition, entry metadata) without needing changes here.
 *
 * Behaviour:
 *  - Reads `settings:connectEnabled` via the admin settings API on mount.
 *  - When multi-vendor is off, renders an info banner instead of the picker.
 *  - When on, fetches `admin/vendors` and renders a searchable Combobox of
 *    active/pending vendors, dimming entries with `chargesEnabled=false`.
 */

import { useEffect, useMemo, useState } from "react";
import {
	Alert,
	Combobox,
	FormField,
	Loading,
	usePluginAPI,
	type ComboboxOption,
} from "../kit";
import type { Vendor } from "../../types";

export interface VendorSelectProps {
	value?: string | null;
	onChange?: (next: string | null) => void;
	field?: { label?: string; help?: string; required?: boolean };
	readOnly?: boolean;
}

export function VendorSelect(props: VendorSelectProps) {
	const api = usePluginAPI();
	const [vendors, setVendors] = useState<Vendor[] | null>(null);
	const [connectEnabled, setConnectEnabled] = useState<boolean | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		async function load(): Promise<void> {
			try {
				const settings = await api.get<Record<string, unknown>>("admin/settings");
				if (!alive) return;
				const on = settings.connectEnabled === true;
				setConnectEnabled(on);
				if (on) {
					try {
						const res = await api.get<{ items: Vendor[] }>("admin/vendors");
						if (alive) setVendors(res.items ?? []);
					} catch (err) {
						if (alive)
							setError(
								err instanceof Error ? err.message : "Could not load vendors",
							);
					}
				}
			} catch (err) {
				if (alive)
					setError(err instanceof Error ? err.message : "Could not load settings");
			}
		}
		load();
		return () => {
			alive = false;
		};
	}, [api]);

	const options = useMemo<ComboboxOption[]>(() => {
		if (!vendors) return [];
		return vendors.map((v) => {
			const statusHint =
				v.onboardingStatus === "active" && v.chargesEnabled
					? "Active"
					: v.onboardingStatus === "restricted"
						? "Restricted"
						: "Pending";
			return {
				value: v.id,
				label: `${v.name} · ${v.email}`,
				hint: statusHint,
				disabled: !v.chargesEnabled,
			};
		});
	}, [vendors]);

	const { value, onChange, field, readOnly } = props;
	const label = field?.label ?? "Vendor";

	if (connectEnabled === null) {
		return <Loading label="Loading vendor options…" />;
	}

	if (!connectEnabled) {
		return (
			<FormField
				label={label}
				description={field?.help}
				{...(field?.required ? { required: true } : {})}
			>
				<Alert type="info" title="Multi-vendor marketplace is off">
					Enable it in Settings → Stripe Connect to assign products to vendors.
					Leave this field blank for now.
				</Alert>
			</FormField>
		);
	}

	if (error) {
		return (
			<FormField label={label}>
				<Alert type="error" title="Could not load vendors">
					{error}
				</Alert>
			</FormField>
		);
	}

	const activeCount = vendors?.filter((v) => v.chargesEnabled).length ?? 0;

	return (
		<FormField
			label={label}
			description={
				field?.help ??
				(activeCount === 0
					? "No vendors are ready to charge yet. Onboard one in Vendors first."
					: "Pick the vendor whose Stripe Connect account should receive funds for this product.")
			}
			{...(field?.required ? { required: true } : {})}
		>
			<Combobox
				value={value ?? null}
				onChange={(next) => onChange?.(next)}
				options={options}
				placeholder={activeCount === 0 ? "No vendors available" : "Select a vendor…"}
				{...(activeCount === 0 || readOnly ? { disabled: true } : {})}
				allowClear
			/>
		</FormField>
	);
}

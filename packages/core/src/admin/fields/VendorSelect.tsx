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
 *  - Reads `settings:connectEnabled` and the registered providers' `splits`
 *    capability via the admin settings API on mount.
 *  - Marketplace mode is Stripe Connect **or** a provider that can split
 *    payments (Flutterwave subaccounts).
 *  - When neither is on, renders an info banner instead of the picker.
 *  - When on, fetches `admin/vendors` and renders a searchable Combobox,
 *    dimming vendors with no active payout account.
 */

import { useEffect, useMemo, useState } from "react";
import type { Vendor } from "../../types";
import { Alert, Combobox, type ComboboxOption, FormField, Loading, usePluginAPI } from "../kit";

export interface VendorSelectProps {
	value?: string | null;
	onChange?: (next: string | null) => void;
	field?: { label?: string; help?: string; required?: boolean };
	readOnly?: boolean;
}

export function VendorSelect(props: VendorSelectProps) {
	const api = usePluginAPI();
	const [vendors, setVendors] = useState<Vendor[] | null>(null);
	const [marketplaceEnabled, setMarketplaceEnabled] = useState<boolean | null>(null);
	const [connectEnabled, setConnectEnabled] = useState(false);
	const [splitsProviders, setSplitsProviders] = useState<Array<{ id: string; label: string }>>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		async function load(): Promise<void> {
			try {
				const settings = await api.get<Record<string, unknown>>("admin/settings");
				if (!alive) return;
				const connect = settings.connectEnabled === true;
				const providers = Array.isArray(settings._providers)
					? (settings._providers as Array<{
							id: string;
							label: string;
							capabilities?: { splits?: boolean };
						}>)
					: [];
				const splits = providers
					.filter((provider) => provider.capabilities?.splits === true)
					.map((provider) => ({ id: provider.id, label: provider.label }));
				const enabled = connect || splits.length > 0;
				setConnectEnabled(connect);
				setSplitsProviders(splits);
				setMarketplaceEnabled(enabled);
				if (enabled) {
					try {
						const res = await api.get<{ items: Vendor[] }>("admin/vendors");
						if (alive) setVendors(res.items ?? []);
					} catch (err) {
						if (alive) setError(err instanceof Error ? err.message : "Could not load vendors");
					}
				}
			} catch (err) {
				if (alive) setError(err instanceof Error ? err.message : "Could not load settings");
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
			const stripeReady = connectEnabled && v.chargesEnabled;
			const providerReady = splitsProviders.some(
				(provider) => v.paymentAccounts?.[provider.id]?.status === "active",
			);
			const ready = stripeReady || providerReady;
			const statusHint = ready
				? "Active"
				: v.onboardingStatus === "restricted"
					? "Restricted"
					: "Pending";
			return {
				value: v.id,
				label: `${v.name} · ${v.email}`,
				hint: statusHint,
				disabled: !ready,
			};
		});
	}, [vendors, connectEnabled, splitsProviders]);

	const { value, onChange, field, readOnly } = props;
	const label = field?.label ?? "Vendor";

	if (marketplaceEnabled === null) {
		return <Loading label="Loading vendor options…" />;
	}

	if (!marketplaceEnabled) {
		return (
			<FormField
				label={label}
				description={field?.help}
				{...(field?.required ? { required: true } : {})}
			>
				<Alert type="info" title="Multi-vendor marketplace is off">
					Enable it in Settings, or install a payment provider that supports split payments, to
					assign products to vendors. Leave this field blank for now.
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
